import { prisma } from "./db.server";
import { ethers } from "ethers";
import { Attestation, Schema } from "@prisma/client";
import dayjs from "dayjs";
import pLimit from "p-limit";
import { Eas__factory, EasSchema__factory } from "./types/ethers-contracts";
import { SchemaEncoder } from "@ethereum-attestation-service/eas-sdk";
import * as fs from "fs";

const batchSize = process.env.BATCH_SIZE
  ? Number(process.env.BATCH_SIZE)
  : 9500;

const requestDelay = process.env.REQUEST_DELAY
  ? Number(process.env.REQUEST_DELAY)
  : 0;

const limit = pLimit(5);

export type EASChainConfig = {
  chainId: number;
  chainName: string;
  version: string;
  contractAddress: string;
  schemaRegistryAddress: string;
  etherscanURL: string;
  /** Must contain a trailing dot (unless mainnet). */
  subdomain: string;
  contractStartBlock: number;
  rpcProvider: string;
};

export const CHAIN_ID = Number(process.env.CHAIN_ID);

if (!CHAIN_ID) {
  throw new Error("No chain ID specified");
}

export const EAS_CHAIN_CONFIGS: EASChainConfig[] = [
  {
    chainId: 11155111,
    chainName: "sepolia",
    subdomain: "",
    version: "1.3.6",
    contractAddress: "0x55F8302b4755a04E2C2D36f219A8595e421C2942",
    schemaRegistryAddress: "0xF4EF535660588e3CF0B2be91C884eBF350652bD9",
    contractStartBlock: 5883638,
    etherscanURL: "https://sepolia.etherscan.io",
    rpcProvider: `https://eth-sepolia.g.alchemy.com/v2/qKOejal-tbfyH6_jIHxCGwExilHgqmbF`,
  },
];

const activeChainConfig = EAS_CHAIN_CONFIGS.find(
  (config) => config.chainId === CHAIN_ID
);

if (!activeChainConfig) {
  throw new Error("No chain config found for chain ID");
}

export const EASContractAddress = activeChainConfig.contractAddress;
export const EASSchemaRegistryAddress = activeChainConfig.schemaRegistryAddress;
export const CONTRACT_START_BLOCK = activeChainConfig.contractStartBlock;
export const revokedEventSignature = "Revoked(address,address,bytes32,bytes32)";
export const revokedOffchainEventSignature =
  "RevokedOffchain(address,bytes32,uint64)";
export const attestedEventSignature =
  "Attested(address,address,bytes32,bytes32)";
export const registeredEventSignatureV1 = "Registered(bytes32,address)";
export const registeredEventSignatureV2 =
  "Registered(bytes32,address,(bytes32,address,bool,string))";

export const timestampEventSignature = "Timestamped(bytes32,uint64)";
export const schemaNameUID =
  "0x44d562ac1d7cd77e232978687fea027ace48f719cf1d58c7888e509663bb87fc"; // Sepolia v0.25

export const provider = new ethers.providers.StaticJsonRpcProvider(
  activeChainConfig.rpcProvider,
  activeChainConfig.chainId
);

const schemaContract = EasSchema__factory.connect(
  EASSchemaRegistryAddress,
  provider
);

const easContract = Eas__factory.connect(EASContractAddress, provider);

// Timeout Promise
function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const safeToNumber = (num: ethers.BigNumber) => {
  try {
    const tmpNum = num.toNumber();
    if (tmpNum > 2147483647) {
      return 2147483647;
    } else {
      return tmpNum;
    }
  } catch (error) {
    console.log("Error converting to number", error);

    // return max number
    return 2147483647;
  }
};

export async function getFormattedAttestationFromLog(
  log: ethers.providers.Log
): Promise<Attestation | null> {
  let UID = ethers.constants.HashZero;
  let schemaUID = ethers.constants.HashZero;
  let refUID = ethers.constants.HashZero;
  let time = ethers.BigNumber.from(0);
  let expirationTime = ethers.BigNumber.from(0);
  let revocationTime = ethers.BigNumber.from(0);
  let recipient = ethers.constants.AddressZero;
  let attester = ethers.constants.AddressZero;
  let revocable = false;
  let data = "";

  let tries = 1;

  do {
    [
      UID,
      schemaUID,
      time,
      expirationTime,
      revocationTime,
      refUID,
      recipient,
      attester,
      revocable,
      data,
    ] = await easContract.getAttestation(log.data);

    if (UID === ethers.constants.HashZero) {
      console.log(`Delaying attestation poll after try #${tries}...`);
      await timeout(500);
    }

    tries++;
  } while (UID === ethers.constants.HashZero);

  let decodedDataJson = "";

  try {
    const schema = await prisma.schema.findUnique({
      where: { id: schemaUID },
    });

    if (!schema) {
      return null;
    }

    const schemaEncoder = new SchemaEncoder(schema.schema);
    decodedDataJson = JSON.stringify(schemaEncoder.decodeData(data));
  } catch (error) {
    console.log("Error decoding data 53432", error);
  }

  return {
    id: UID,
    schemaId: schemaUID,
    data,
    attester,
    recipient,
    refUID: refUID,
    revocationTime: safeToNumber(revocationTime),
    expirationTime: safeToNumber(expirationTime),
    time: time.toNumber(),
    txid: log.transactionHash,
    revoked: revocationTime.lt(dayjs().unix()) && !revocationTime.isZero(),
    isOffchain: false,
    ipfsHash: "",
    timeCreated: dayjs().unix(),
    revocable,
    decodedDataJson,
  };
}

export async function getFormattedSchemaFromLog(
  log: ethers.providers.Log
): Promise<Omit<Schema, "index">> {
  let UID = ethers.constants.HashZero;
  let resolver = ethers.constants.AddressZero;
  let revocable = false;
  let schema = "";

  let tries = 1;

  do {
    [UID, resolver, revocable, schema] = await schemaContract.getSchema(
      log.topics[1]
    );

    if (UID === ethers.constants.HashZero) {
      console.log(`Delaying schema poll after try #${tries}...`);
      await timeout(500);
    }

    tries++;
  } while (UID === ethers.constants.HashZero);

  const block = await provider.getBlock(log.blockNumber);
  const tx = await provider.getTransaction(log.transactionHash);

  return {
    id: UID,
    schema: schema,
    creator: tx.from,
    resolver,
    time: block.timestamp,
    txid: log.transactionHash,
    revocable,
  };
}

export async function revokeAttestationsFromLogs(logs: ethers.providers.Log[]) {
  for (let log of logs) {
    const attestation = await easContract.getAttestation(log.data);

    const attestationFromDb = await prisma.attestation.findUnique({
      where: { id: attestation[0] },
    });

    if (!attestationFromDb) {
      console.log("Attestation not found in DB", attestation[0]);

      // Should never happen, but log it just in case
      fs.appendFileSync(
        "attestations_not_found_for_revoke.txt",
        `${attestation[0]}\n`
      );

      continue;
    }

    const updatedAttestatrion = await prisma.attestation.update({
      where: { id: attestation[0] },
      data: {
        revoked: true,
        revocationTime: attestation.revocationTime.toNumber(),
      },
    });

    await processRevokedAttestation(updatedAttestatrion);
  }
}

export async function createSchemasFromLogs(logs: ethers.providers.Log[]) {
  const promises = logs.map((log) =>
    limit(() => getFormattedSchemaFromLog(log))
  );

  const schemas = await Promise.all(promises);

  let schemaCount = await prisma.schema.count();

  for (let schema of schemas) {
    schemaCount++;

    console.log("Creating new schema", schema);
    try {
      await prisma.schema.create({
        data: { ...schema, index: schemaCount.toString() },
      });
    } catch (error) {
      console.log("Error creating schema", error);
    }
  }
}

export async function createAttestationsForLogs(logs: ethers.providers.Log[]) {
  const promises = logs.map((log) =>
    limit(() => getFormattedAttestationFromLog(log))
  );

  const attestations = await Promise.all(promises);

  for (let attestation of attestations) {
    if (attestation !== null) {
      const existingAttestation = await prisma.attestation.findUnique({
        where: { id: attestation.id },
      });

      if (existingAttestation) {
        console.log("Attestation already exists", attestation.id);
      } else {
        console.log("Creating new attestation", attestation);

        await prisma.attestation.create({ data: attestation });
        await processCreatedAttestation(attestation);
      }
    }
  }
}

export async function createOffchainRevocationsForLogs(
  logs: ethers.providers.Log[]
) {
  for (let log of logs) {
    const uid = log.topics[2];
    const timestamp = ethers.BigNumber.from(log.topics[3]).toNumber();
    console.log("Creating new offchainrevoke Log for", uid, timestamp);

    const tx = await provider.getTransaction(log.transactionHash);

    const newRevocation = await prisma.offchainRevocation.create({
      data: {
        timestamp,
        uid,
        from: tx.from,
        txid: log.transactionHash,
      },
    });

    await prisma.attestation.updateMany({
      where: { id: uid, isOffchain: true, attester: tx.from },
      data: {
        revoked: true,
        revocationTime: newRevocation.timestamp,
      },
    });
  }
}

export async function createTimestampForLogs(logs: ethers.providers.Log[]) {
  for (let log of logs) {
    const uid = log.topics[1];
    const timestamp = ethers.BigNumber.from(log.topics[2]).toNumber();
    console.log("Creating new Log for", uid, timestamp);

    const tx = await provider.getTransaction(log.transactionHash);

    await prisma.timestamp.create({
      data: {
        id: uid,
        timestamp,
        from: tx.from,
        txid: log.transactionHash,
      },
    });
  }
}

export async function processRevokedAttestation(
  attestation: Attestation
): Promise<void> {
  if (attestation.schemaId === schemaNameUID) {
    try {
      const decodedNameAttestationData = ethers.utils.defaultAbiCoder.decode(
        ["bytes32", "string"],
        attestation.data
      );

      console.log("Removing schema name: ", decodedNameAttestationData[1]);

      console.log({
        name: decodedNameAttestationData[1],
        schemaId: decodedNameAttestationData[0],
        attesterAddress: attestation.attester,
      });

      await prisma.schemaName.deleteMany({
        where: {
          name: decodedNameAttestationData[1],
          schemaId: decodedNameAttestationData[0],
          attesterAddress: attestation.attester,
        },
      });
    } catch (e) {
      console.log("Error: Unable to decode schema name", e);
      return;
    }
  }
}

export async function processCreatedAttestation(
  attestation: Attestation
): Promise<void> {
  if (attestation.schemaId === schemaNameUID) {
    try {
      const decodedNameAttestationData = ethers.utils.defaultAbiCoder.decode(
        ["bytes32", "string"],
        attestation.data
      );

      const schema = await prisma.schema.findUnique({
        where: { id: decodedNameAttestationData[0] },
      });

      if (!schema) {
        console.log("Error: Schema doesnt exist!");
        return;
      }

      console.log("Adding new schema name: ", decodedNameAttestationData[1]);

      await prisma.schemaName.create({
        data: {
          name: decodedNameAttestationData[1],
          schemaId: schema.id,
          time: dayjs().unix(),
          attesterAddress: attestation.attester,
          isCreator:
            attestation.attester.toLowerCase() === schema.creator.toLowerCase(),
        },
      });
    } catch (e) {
      console.log("Error: Unable to decode schema name", e);
      return;
    }
  }
}

export async function updateServiceStatToLastBlock(
  shouldCreate: boolean,
  serviceStatPropertyName: string,
  lastBlock: number
) {
  const existing = await prisma.serviceStat.findFirst({
    where: { name: serviceStatPropertyName },
  });

  if (!existing || shouldCreate) {
    await prisma.serviceStat.create({
      data: { name: serviceStatPropertyName, value: lastBlock.toString() },
    });
  } else {
    if (lastBlock !== 0) {
      await prisma.serviceStat.update({
        where: { name: serviceStatPropertyName },
        data: { value: lastBlock.toString() },
      });
    }
  }
}

async function getStartData(serviceStatPropertyName: string) {
  const latestBlockNumServiceStat = await prisma.serviceStat.findFirst({
    where: { name: serviceStatPropertyName },
  });

  let fromBlock: number = CONTRACT_START_BLOCK;

  if (latestBlockNumServiceStat?.value) {
    fromBlock = Number(latestBlockNumServiceStat.value);
  }

  if (fromBlock === 0) {
    fromBlock = CONTRACT_START_BLOCK;
  }

  return { latestBlockNumServiceStat, fromBlock };
}

export async function updateDbFromRelevantLog(log: ethers.providers.Log) {
  if (log.address === EASSchemaRegistryAddress) {
    if (
      log.topics[0] === ethers.utils.id(registeredEventSignatureV1) ||
      log.topics[0] === ethers.utils.id(registeredEventSignatureV2)
    ) {
      await createSchemasFromLogs([log]);
    }
  } else if (log.address === EASContractAddress) {
    if (log.topics[0] === ethers.utils.id(attestedEventSignature)) {
      await createAttestationsForLogs([log]);
    } else if (log.topics[0] === ethers.utils.id(revokedEventSignature)) {
      await revokeAttestationsFromLogs([log]);
    } else if (log.topics[0] === ethers.utils.id(timestampEventSignature)) {
      await createTimestampForLogs([log]);
    } else if (
      log.topics[0] === ethers.utils.id(revokedOffchainEventSignature)
    ) {
      await createOffchainRevocationsForLogs([log]);
    }
  }
}

export async function getAndUpdateAllRelevantLogs() {
  const eventSignatures = [
    ethers.utils.id(revokedEventSignature),
    ethers.utils.id(revokedOffchainEventSignature),
    ethers.utils.id(attestedEventSignature),
    ethers.utils.id(timestampEventSignature),
  ];

  const serviceStatPropertyName = "latestAttestationBlockNum";

  const { fromBlock } = await getStartData(serviceStatPropertyName);

  let currentBlock = fromBlock + 1;
  const latestBlock = await provider.getBlockNumber();

  let allLogs: ethers.providers.Log[] = [];

  while (currentBlock <= latestBlock) {
    const toBlock = Math.min(currentBlock + batchSize - 1, latestBlock);

    console.log(
      `Getting and updating all relevant logs from block ${currentBlock} to ${toBlock}`
    );

    const schemaLogs = await provider.getLogs({
      address: EASSchemaRegistryAddress,
      fromBlock: currentBlock,
      toBlock,
      topics: [
        [
          ethers.utils.id(registeredEventSignatureV1),
          ethers.utils.id(registeredEventSignatureV2),
        ],
      ],
    });

    allLogs = allLogs.concat(schemaLogs);

    for (const log of schemaLogs) {
      await updateDbFromRelevantLog(log);
      await timeout(requestDelay);
    }

    const easLogs = await provider.getLogs({
      address: EASContractAddress,
      fromBlock: currentBlock,
      toBlock,
      topics: [eventSignatures], // Filter by all event signatures
    });

    allLogs = allLogs.concat(easLogs);

    for (const log of easLogs) {
      await updateDbFromRelevantLog(log);
      await timeout(requestDelay);
    }

    await updateServiceStatToLastBlock(false, serviceStatPropertyName, toBlock);

    currentBlock += batchSize;
    await timeout(requestDelay);
  }

  console.log("total  logs", allLogs.length);
}

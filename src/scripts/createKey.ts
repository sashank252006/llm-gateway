import 'dotenv/config';
import { getPrisma } from '../infra/prisma.js';
import { generateKey, hashKey, getKeyPrefix } from '../keys/index.js';

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length);
}

function positiveInteger(name: string, fallback: number): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`--${name} must be a positive integer`);
  return number;
}

const name = option('name') ?? 'default';
const rateLimitRpm = positiveInteger('rate-limit-rpm', 60);
const rateLimitBurst = positiveInteger('rate-limit-burst', 20);
const maxOutputTokensCap = positiveInteger('max-output-tokens-cap', 4096);

const prisma = getPrisma();
const plainKey = generateKey();
const kHash = hashKey(plainKey);
const kPrefix = getKeyPrefix(plainKey);

const key = await prisma.apiKey.create({
  data: { name, keyPrefix: kPrefix, keyHash: kHash, rateLimitRpm, rateLimitBurst, maxOutputTokensCap },
});

console.log('Key created:');
console.log(`  ID:   ${key.id}`);
console.log(`  Name: ${key.name}`);
console.log(`  Key:  ${plainKey}`);
console.log('Store the key securely — it is shown only once.');

await prisma.$disconnect();

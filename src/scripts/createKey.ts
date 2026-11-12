import 'dotenv/config';
import { getPrisma } from '../infra/prisma.js';
import { generateKey, hashKey, getKeyPrefix } from '../keys/index.js';

const name = process.argv.find((a) => a.startsWith('--name='))?.split('=')[1] ?? 'default';

const prisma = getPrisma();
const plainKey = generateKey();
const kHash = hashKey(plainKey);
const kPrefix = getKeyPrefix(plainKey);

const key = await prisma.apiKey.create({
  data: { name, keyPrefix: kPrefix, keyHash: kHash },
});

console.log('Key created:');
console.log(`  ID:   ${key.id}`);
console.log(`  Name: ${key.name}`);
console.log(`  Key:  ${plainKey}`);
console.log('Store the key securely — it is shown only once.');

await prisma.$disconnect();


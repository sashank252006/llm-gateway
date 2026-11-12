import { PrismaClient } from '@prisma/client';
import { logger } from '../observability/logger.js';

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient();
    _prisma.$connect().catch((err: Error) => {
      logger.error({ msg: 'Prisma connect error', error: err.message });
    });
  }
  return _prisma;
}

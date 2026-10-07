import { PrismaClient } from '../generated/prisma/index.js';

/** Shared Prisma client. Auth and Nest both import this. */
export const prisma = new PrismaClient();

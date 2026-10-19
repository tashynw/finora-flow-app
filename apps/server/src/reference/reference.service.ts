import { Injectable } from '@nestjs/common';
import { Currency } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type NamedRef = {
  id: string;
  code: string;
  name: string;
};

const ACTIVE_ONLY = { isActive: true, archivedAt: null } as const;

@Injectable()
export class ReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getReferenceData() {
    const [vendors, costCentres, glAccounts, departments] = await Promise.all([
      this.prisma.vendor.findMany({
        where: ACTIVE_ONLY,
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.costCentre.findMany({
        where: ACTIVE_ONLY,
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.glAccount.findMany({
        where: ACTIVE_ONLY,
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.department.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, costCentreNumber: true, name: true },
      }),
    ]);

    const departmentRefs: NamedRef[] = departments.map((d) => ({
      id: d.id,
      code: d.costCentreNumber,
      name: d.name,
    }));

    return {
      vendors,
      cost_centres: costCentres,
      gl_accounts: glAccounts,
      departments: departmentRefs,
      currencies: [Currency.JMD, Currency.USD],
    };
  }
}

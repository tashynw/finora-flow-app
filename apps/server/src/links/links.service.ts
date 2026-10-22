import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

const REFUSAL = 'This link no longer works.';

@Injectable()
export class LinksService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(input: {
    recordType: string;
    recordId: string;
    purpose: string;
    issuedToId: string;
    ttlHours?: number;
  }) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + (input.ttlHours ?? 72) * 60 * 60 * 1000,
    );
    await this.prisma.signedLink.create({
      data: {
        tokenSha256: this.digest(token),
        recordType: input.recordType,
        recordId: input.recordId,
        purpose: input.purpose,
        issuedToId: input.issuedToId,
        expiresAt,
      },
    });
    const origin = process.env.WEB_APP_URL ?? 'http://localhost:5173';
    return { token, url: `${origin}/link/${token}`, expiresAt };
  }

  async resolve(token: string, userId: string) {
    const link = await this.prisma.signedLink.findUnique({
      where: { tokenSha256: this.digest(token) },
    });
    const refused =
      !link ||
      link.revokedAt != null ||
      link.usedAt != null ||
      link.expiresAt.getTime() < Date.now() ||
      (link.issuedToId != null && link.issuedToId !== userId);
    if (!link || refused) {
      throw new DomainException(REFUSAL, HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    await this.prisma.signedLink.update({
      where: { id: link.id },
      data: { usedAt: new Date() },
    });
    return {
      record_type: link.recordType,
      record_id: link.recordId,
      purpose: link.purpose,
    };
  }

  private digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}

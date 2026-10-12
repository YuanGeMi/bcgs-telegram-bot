import { Prisma, type PrismaClient } from '@prisma/client';
import type { CaseNotificationContent } from './message';

export const LEASE_SECONDS = 120;

export type ClaimedNotification = CaseNotificationContent & {
  id: string;
  complaintId: string;
  revision: number;
  telegramUserId: string;
  /** Attempts including this one. */
  attempts: number;
};

/** Everything the worker reads or writes. The only writes are updates to "CaseNotificationOutbox" rows. */
export interface OutboxStore {
  /** Expired "processing" leases go back to "pending"; returns how many. */
  recoverExpiredLeases(): Promise<number>;
  /** Claims due rows whose earlier revisions (same case) are already settled. */
  claim(limit: number): Promise<ClaimedNotification[]>;
  markSent(id: string, telegramMessageId: string): Promise<void>;
  markPermanentFailure(id: string, errorCode: string): Promise<void>;
  /** Back to "pending" at `delaySeconds` from now; `refundAttempt` undoes this claim's attempt (429). */
  scheduleRetry(id: string, delaySeconds: number, errorCode: string, refundAttempt: boolean): Promise<void>;
  /** The user's saved language, read fresh (no cache). */
  readLanguage(telegramUserId: string): Promise<string | null>;
}

// Timestamps are stored as UTC "timestamp without time zone" (what Prisma writes), whatever the session time zone.
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

export function prismaOutboxStore(prisma: PrismaClient): OutboxStore {
  return {
    async recoverExpiredLeases() {
      return prisma.$executeRaw`
        UPDATE "CaseNotificationOutbox"
        SET "state" = 'pending', "leaseExpiresAt" = NULL, "updatedAt" = ${NOW}
        WHERE "state" = 'processing' AND "leaseExpiresAt" < ${NOW}`;
    },

    async claim(limit) {
      const [rows] = await prisma.$transaction([
        prisma.$queryRaw<ClaimedNotification[]>`
          WITH due AS (
            SELECT o."id"
            FROM "CaseNotificationOutbox" o
            WHERE o."state" = 'pending'
              AND o."nextAttemptAt" <= ${NOW}
              AND NOT EXISTS (
                SELECT 1 FROM "CaseNotificationOutbox" earlier
                WHERE earlier."complaintId" = o."complaintId"
                  AND earlier."revision" < o."revision"
                  AND earlier."state" IN ('pending', 'processing')
              )
            ORDER BY o."createdAt", o."id"
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE "CaseNotificationOutbox" c
          SET "state" = 'processing',
              "leaseExpiresAt" = ${NOW} + make_interval(secs => ${LEASE_SECONDS}),
              "attempts" = c."attempts" + 1,
              "updatedAt" = ${NOW}
          FROM due
          WHERE c."id" = due."id"
          RETURNING c."id", c."complaintId", c."revision", c."telegramUserId", c."caseId",
                    c."type"::text AS "type", c."status"::text AS "status", c."casinoLabel",
                    c."userMessage", c."caseUpdatedAt", c."attempts"`,
      ]);
      return rows;
    },

    async markSent(id, telegramMessageId) {
      await prisma.$executeRaw`
        UPDATE "CaseNotificationOutbox"
        SET "state" = 'sent', "sentAt" = ${NOW}, "telegramMessageId" = ${telegramMessageId},
            "leaseExpiresAt" = NULL, "errorCode" = NULL, "updatedAt" = ${NOW}
        WHERE "id" = ${id} AND "state" = 'processing'`;
    },

    async markPermanentFailure(id, errorCode) {
      await prisma.$executeRaw`
        UPDATE "CaseNotificationOutbox"
        SET "state" = 'permanent_failure', "errorCode" = ${errorCode}, "leaseExpiresAt" = NULL, "updatedAt" = ${NOW}
        WHERE "id" = ${id} AND "state" = 'processing'`;
    },

    async scheduleRetry(id, delaySeconds, errorCode, refundAttempt) {
      await prisma.$executeRaw`
        UPDATE "CaseNotificationOutbox"
        SET "state" = 'pending',
            "nextAttemptAt" = ${NOW} + make_interval(secs => ${delaySeconds}),
            "attempts" = CASE WHEN ${refundAttempt} THEN GREATEST("attempts" - 1, 0) ELSE "attempts" END,
            "errorCode" = ${errorCode}, "leaseExpiresAt" = NULL, "updatedAt" = ${NOW}
        WHERE "id" = ${id} AND "state" = 'processing'`;
    },

    async readLanguage(telegramUserId) {
      const row = await prisma.telegramUserSetting.findUnique({
        where: { telegramUserId },
        select: { language: true },
      });
      return row?.language ?? null;
    },
  };
}

-- Initial schema for payments-demo.
-- This is the SQL form of prisma/schema.prisma, included so codegraph's
-- (future) SQL adapter has a fixture to lift table-level edges from.

CREATE TABLE "Customer" (
    "id"               TEXT      PRIMARY KEY,
    "email"            TEXT      NOT NULL UNIQUE,
    "country"          TEXT      NOT NULL DEFAULT 'US',
    "ageDays"          INTEGER   NOT NULL DEFAULT 0,
    "priorChargebacks" INTEGER   NOT NULL DEFAULT 0,
    "velocityPerHour"  INTEGER   NOT NULL DEFAULT 0,
    "verified"         BOOLEAN   NOT NULL DEFAULT FALSE,
    "createdAt"        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Charge" (
    "id"         TEXT      PRIMARY KEY,
    "customerId" TEXT      NOT NULL REFERENCES "Customer"("id"),
    "amount"     INTEGER   NOT NULL,
    "currency"   TEXT      NOT NULL,
    "status"     TEXT      NOT NULL,
    "riskScore"  INTEGER   NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Refund" (
    "id"        TEXT      PRIMARY KEY,
    "chargeId"  TEXT      NOT NULL REFERENCES "Charge"("id"),
    "reason"    TEXT      NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Charge_customerId_idx" ON "Charge"("customerId");
CREATE INDEX "Refund_chargeId_idx" ON "Refund"("chargeId");

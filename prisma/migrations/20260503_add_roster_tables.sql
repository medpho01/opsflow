-- CreateTable: WeeklySchedule
CREATE TABLE taskos.weekly_schedules (
  id SERIAL PRIMARY KEY,
  "teamMemberId" INTEGER NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  "isWorking" BOOLEAN NOT NULL DEFAULT true,
  "startTime" VARCHAR(5),
  "endTime" VARCHAR(5),
  "breakStart" VARCHAR(5),
  "breakEnd" VARCHAR(5),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT weekly_schedules_teamMemberId_dayOfWeek_key UNIQUE ("teamMemberId", "dayOfWeek"),
  CONSTRAINT weekly_schedules_teamMemberId_fkey FOREIGN KEY ("teamMemberId") REFERENCES taskos.team_members(id) ON DELETE CASCADE
);

-- CreateIndex: weekly_schedules_teamMemberId_idx
CREATE INDEX weekly_schedules_teamMemberId_idx ON taskos.weekly_schedules("teamMemberId");

-- CreateIndex: weekly_schedules_dayOfWeek_idx
CREATE INDEX weekly_schedules_dayOfWeek_idx ON taskos.weekly_schedules("dayOfWeek");

-- CreateTable: RosterException
CREATE TABLE taskos.roster_exceptions (
  id SERIAL PRIMARY KEY,
  "teamMemberId" INTEGER NOT NULL,
  date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  note TEXT,
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT roster_exceptions_teamMemberId_date_key UNIQUE ("teamMemberId", date),
  CONSTRAINT roster_exceptions_teamMemberId_fkey FOREIGN KEY ("teamMemberId") REFERENCES taskos.team_members(id) ON DELETE CASCADE
);

-- CreateIndex: roster_exceptions_teamMemberId_idx
CREATE INDEX roster_exceptions_teamMemberId_idx ON taskos.roster_exceptions("teamMemberId");

-- CreateIndex: roster_exceptions_date_idx
CREATE INDEX roster_exceptions_date_idx ON taskos.roster_exceptions(date);

-- CreateIndex: roster_exceptions_createdAt_idx
CREATE INDEX roster_exceptions_createdAt_idx ON taskos.roster_exceptions("createdAt");

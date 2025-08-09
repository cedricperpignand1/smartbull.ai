import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  await prisma.botState.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      cash: 4000,
      pnl: 0,
      equity: 4000,
      lastRunDay: null
    }
  });
  console.log("Seeded BotState with $4000.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

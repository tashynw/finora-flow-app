import { auth } from '../src/better-auth/config.js';
import { prisma } from '../src/prisma/client.js';

async function seedDefaultAdmin() {
  const email = process.env.DEFAULT_ADMIN_EMAIL;
  if (!email) {
    throw new Error('DEFAULT_ADMIN_EMAIL is not set');
  }

  const existing = await prisma.user.findUnique({
    where: { email },
  });

  if (existing) {
    console.log(`Default admin already exists: ${email}`);
    return existing;
  }

  const password = process.env.DEFAULT_PASSWORD ?? '6a7gH8B39';

  const res = await auth.api.signUpEmail({
    body: {
      name: 'Default Admin',
      email,
      password,
    },
  });

  const userId = res.user.id;

  const admin = await prisma.user.update({
    where: { id: userId },
    data: {
      role: 'administrator',
      emailVerified: true,
    },
  });

  console.log(`Seeded default admin: ${admin.email}`);
  return admin;
}

async function main() {
  await seedDefaultAdmin();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

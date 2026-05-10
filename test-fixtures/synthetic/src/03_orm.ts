// Exercises: Prisma-style ORM. Model declared inline (would normally live in
// schema.prisma); the adapter must pair `prisma.user.*` calls to model "User".

interface User {
  id: string;
  email: string;
  name: string;
}

interface PrismaClient {
  user: {
    findMany(args?: { where?: Partial<User> }): Promise<User[]>;
    findUnique(args: { where: { id: string } }): Promise<User | null>;
    create(args: { data: Omit<User, "id"> }): Promise<User>;
    update(args: { where: { id: string }; data: Partial<User> }): Promise<User>;
  };
}

declare const prisma: PrismaClient;

export async function listActiveUsers(): Promise<User[]> {
  return prisma.user.findMany({ where: { name: "active" } });
}

export async function createUser(email: string, name: string): Promise<User> {
  return prisma.user.create({ data: { email, name } });
}

// Exercises: generic class + type-parameter resolution at instantiation site.
// `new Repo<User>()` should resolve T -> User in the IR's valueType fields.

interface User {
  id: string;
  email: string;
}

export class Repo<T extends { id: string }> {
  private items: T[] = [];

  add(item: T): void {
    this.items.push(item);
  }

  get(id: string): T | undefined {
    return this.items.find((x) => x.id === id);
  }

  all(): T[] {
    return this.items;
  }
}

export function makeUserRepo(): Repo<User> {
  return new Repo<User>();
}

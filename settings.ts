export function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`Set ${name} in the project .env or environment.`);
  return value;
}

export interface InstallablePackage {
  key: string;
  aliases: string[];
  packageName: string;
  command: string;
  description: string;
  nextSteps: string[];
}

export const INSTALLABLE_PACKAGES: InstallablePackage[] = [
  {
    key: 'monitoring',
    aliases: ['openbroker-monitoring'],
    packageName: 'openbroker-monitoring',
    command: 'openbroker-monitoring',
    description: 'Local automation dashboard and optional audit observer',
    nextSteps: [
      'openbroker-monitoring serve --host 127.0.0.1 --port 3001',
      'Open http://127.0.0.1:3001',
    ],
  },
  {
    key: 'extended',
    aliases: ['openbroker-extended'],
    packageName: 'openbroker-extended',
    command: 'openbroker-ex',
    description: 'Extended Exchange trading CLI and library',
    nextSteps: [
      'openbroker-ex --help',
      'openbroker-ex setup',
    ],
  },
];

export function resolveInstallablePackage(input: string): InstallablePackage | null {
  const normalized = input.trim().toLowerCase();
  return INSTALLABLE_PACKAGES.find((entry) => (
    entry.key === normalized
    || entry.packageName === normalized
    || entry.aliases.includes(normalized)
  )) ?? null;
}

export function packageSpec(entry: InstallablePackage, tag = 'latest'): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) {
    throw new Error(`invalid package tag or version: ${tag}`);
  }
  return `${entry.packageName}@${tag}`;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'show shortcuts' },
  { name: '/session', description: 'show session id and file' },
  { name: '/copy', description: 'copy transcript/status/input/meta' },
  { name: '/queue', description: 'show queued prompts' },
  { name: '/quit', description: 'exit codingx' },
];

export const SLASH_MENU_MAX = 5;

/** Matches only a bare slash prefix (no arguments/newlines). */
export function slashMatches(text: string): SlashCommand[] {
  if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return [];
  const query = text.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query)).slice(0, SLASH_MENU_MAX);
}

export function slashMenuHeight(text: string, dismissed: boolean): number {
  if (dismissed) return 0;
  return slashMatches(text).length;
}
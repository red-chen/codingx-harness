export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'show shortcuts' },
  { name: '/session', description: 'show session id and file' },
  { name: '/model', description: 'select model and reasoning effort' },
  { name: '/process', description: 'list processes, read logs or stop a process' },
  { name: '/permissions', description: 'show or switch the permission profile' },
  { name: '/clear', description: 'clear session history (UI + JSONL)' },
  { name: '/copy', description: 'copy transcript/status/input/meta' },
  { name: '/queue', description: 'show queued prompts' },
  { name: '/quit', description: 'exit codingx' },
  { name: '/tips', description: 'select a tip to fill the input' },
  { name: '/attach', description: 'attach file lines or a PNG/JPEG/WebP image' },
  { name: '/resume', description: 'select an idle session in this workspace' },
  { name: '/changes', description: 'list file-tool checkpoints' },
  { name: '/undo', description: 'preview and confirm undo by turn id' },
];

/** Matches the 8-row slash menu budget in docs/tui.md. */
export const SLASH_MENU_MAX = 8;

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

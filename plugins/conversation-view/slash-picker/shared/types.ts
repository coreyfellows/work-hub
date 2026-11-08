/** One entry in the `/` picker: a skill, command, plugin command or built-in. Shared by the server and web halves. */
export interface SlashCommand {
  name: string;
  description: string;
  source: 'built-in' | 'user' | 'project' | 'plugin';
  /** The plugin's name, for plugin commands. */
  plugin?: string;
}

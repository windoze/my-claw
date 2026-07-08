/** Helpers for selecting Claude Code settings files for a project cwd. */

import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeCodeSettingsSource = "project" | "default";

export interface ClaudeCodeSettingsSelection {
  source: ClaudeCodeSettingsSource;
  projectSettingsPath: string;
  defaultSettingsPath: string;
  defaultSettingsExists: boolean;
  settingsPath?: string;
}

const CLAUDE_SETTINGS_RELATIVE_PATH = [".claude", "settings.json"] as const;

/** Selects the explicit Claude Code settings file for a project, or SDK defaults. */
export function selectClaudeCodeSettings(cwd: string): ClaudeCodeSettingsSelection {
  const projectSettingsPath = path.join(cwd, ...CLAUDE_SETTINGS_RELATIVE_PATH);
  const defaultSettingsPath = path.join(os.homedir(), ...CLAUDE_SETTINGS_RELATIVE_PATH);
  const defaultSettingsExists = isFile(defaultSettingsPath);

  if (isFile(projectSettingsPath)) {
    return {
      source: "project",
      projectSettingsPath,
      defaultSettingsPath,
      defaultSettingsExists,
      settingsPath: projectSettingsPath,
    };
  }

  return {
    source: "default",
    projectSettingsPath,
    defaultSettingsPath,
    defaultSettingsExists,
  };
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

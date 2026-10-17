/**
 * Every `forge` command, in the order usage output lists them. To add one,
 * create src/commands/<name>.ts exporting a Command and list it here; nothing
 * else in the package needs to change.
 */
import type { Command } from '../command.js';
import { ciWatchCommand } from './ci-watch.js';
import { digestCommand } from './digest.js';
import { haltCommand } from './halt.js';
import { nodeWatchCommand } from './node-watch.js';
import { notifyTestCommand } from './notify-test.js';
import { resumeCommand } from './resume.js';
import { runtimeCommand } from './runtime.js';
import { statusCommand } from './status.js';
import { verifyAuditCommand } from './verify-audit.js';
import { tier0IngestCommand } from './tier0-ingest.js';
import { localScoreboardCommand } from './local-scoreboard.js';

export const commands: readonly Command[] = [
  haltCommand,
  resumeCommand,
  statusCommand,
  verifyAuditCommand,
  notifyTestCommand,
  tier0IngestCommand,
  ciWatchCommand,
  nodeWatchCommand,
  digestCommand,
  runtimeCommand,
  localScoreboardCommand,
];

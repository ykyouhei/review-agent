import { Config } from '../config/index.js';
import { ClaudeAgentRunner } from './claude/runner.js';
import { CopilotAgentRunner } from './copilot/runner.js';
import { AgentRunner } from './types.js';

export function createAgentRunner(
  config: Config,
  onProgress?: (line: string) => void,
): AgentRunner {
  switch (config.agent) {
    case 'claude':
      return new ClaudeAgentRunner({ model: config.model, onProgress });
    case 'copilot':
      return new CopilotAgentRunner({ model: config.model, onProgress });
  }
}

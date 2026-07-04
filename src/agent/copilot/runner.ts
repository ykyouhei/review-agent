import { ReviewOutput } from '../../core/findings.js';
import { AgentRunner, ReviewTask, WikiTask } from '../types.js';

/**
 * Placeholder for the GitHub Copilot SDK (@github/copilot-sdk) backend.
 * The SDK exposes the same shape as the Claude Agent SDK (agentic session
 * with tool access and structured output), so this class only needs to map
 * ReviewTask/WikiTask onto a Copilot session. Planned for phase 2.
 */
export class CopilotAgentRunner implements AgentRunner {
  review(_task: ReviewTask): Promise<ReviewOutput> {
    return Promise.reject(
      new Error('The copilot agent backend is not implemented yet. Use `agent: claude`.'),
    );
  }

  generateWiki(_task: WikiTask): Promise<void> {
    return Promise.reject(
      new Error('The copilot agent backend is not implemented yet. Use `agent: claude`.'),
    );
  }
}

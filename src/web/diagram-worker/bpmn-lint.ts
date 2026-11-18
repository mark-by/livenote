import Linter from 'bpmnlint/lib/linter.js';
import conditionalFlows from 'bpmnlint/rules/conditional-flows.js';
import endEventRequired from 'bpmnlint/rules/end-event-required.js';
import eventBasedGateway from 'bpmnlint/rules/event-based-gateway.js';
import labelRequired from 'bpmnlint/rules/label-required.js';
import noDisconnected from 'bpmnlint/rules/no-disconnected.js';
import noDuplicateSequenceFlows from 'bpmnlint/rules/no-duplicate-sequence-flows.js';
import noGatewayJoinFork from 'bpmnlint/rules/no-gateway-join-fork.js';
import type { BpmnLintIssue } from '../../shared/types';

const rules = new Map([
  ['end-event-required', endEventRequired],
  ['no-disconnected', noDisconnected],
  ['no-duplicate-sequence-flows', noDuplicateSequenceFlows],
  ['label-required', labelRequired],
  ['conditional-flows', conditionalFlows],
  ['no-gateway-join-fork', noGatewayJoinFork],
  ['event-based-gateway', eventBasedGateway]
]);

const linter = new Linter({
  resolver: {
    resolveRule(pkg, name) {
      return pkg === 'bpmnlint' ? rules.get(name) : undefined;
    },
    resolveConfig() {
      return undefined;
    }
  }
});
const config = { rules: Object.fromEntries(Array.from(rules.keys(), (name) => [name, 'warn'])) };

export async function lintBpmn(root: object): Promise<BpmnLintIssue[]> {
  const report = await linter.lint(root, config);
  return Object.entries(report).flatMap(([rule, entries]) => entries.flatMap(({ category, message }) =>
    (category === 'warn' || category === 'error' || category === 'info') && message.length > 0
      ? [{ rule, severity: category, message }]
      : []
  ));
}

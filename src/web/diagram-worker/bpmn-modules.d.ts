/// <reference path="../../server/validator/bpmn-modules.d.ts" />

declare module 'bpmnlint/rules/*.js' {
  const factory: import('bpmnlint/lib/types.js').RuleFactory;
  export default factory;
}

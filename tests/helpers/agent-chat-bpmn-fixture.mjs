export const bpmnPageTitle = 'Выпуск заказа';
export const bpmnPagePath = `${bpmnPageTitle}.md`;
export const bpmnTitle = 'Порядок выпуска заказа';
export const bpmnLabels = ['Заказ принят', 'Проверить заказ', 'Заказ выпущен'];
export const bpmnFlows = ['Flow_Check', 'Flow_Release'];
export const bpmnQuestion = `Создай заметку «${bpmnPageTitle}» со схемой BPMN: ${bpmnLabels.join(', ')}.`;
export const bpmnAnswer = 'Создал заметку со схемой BPMN.';
export const bpmnSource = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_Order" targetNamespace="urn:livenote:fixture">
  <bpmn:process id="Process_Order" isExecutable="false">
    <bpmn:startEvent id="Start_Order" name="${bpmnLabels[0]}"><bpmn:outgoing>${bpmnFlows[0]}</bpmn:outgoing></bpmn:startEvent>
    <bpmn:task id="Task_Check" name="${bpmnLabels[1]}"><bpmn:incoming>${bpmnFlows[0]}</bpmn:incoming><bpmn:outgoing>${bpmnFlows[1]}</bpmn:outgoing></bpmn:task>
    <bpmn:endEvent id="End_Order" name="${bpmnLabels[2]}"><bpmn:incoming>${bpmnFlows[1]}</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="${bpmnFlows[0]}" sourceRef="Start_Order" targetRef="Task_Check" />
    <bpmn:sequenceFlow id="${bpmnFlows[1]}" sourceRef="Task_Check" targetRef="End_Order" />
  </bpmn:process>
</bpmn:definitions>
`;

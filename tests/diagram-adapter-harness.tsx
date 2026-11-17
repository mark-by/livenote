import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@heroui/react';
import { DiagramDialog, DiagramPreview } from '../src/web/diagrams';
import type { DiagramSession, DiagramValue } from '../src/web/diagrams';
import '../src/web/heroui.css';
import '../src/web/styles.css';
import '../src/web/vault.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
const existingBpmn = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Пользовательский комментарий и CRLF должны сохраниться. -->
<b:definitions xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:d="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:c="http://www.omg.org/spec/DD/20100524/DC" targetNamespace="urn:fixture">
 <b:process id="Process_1" isExecutable="false"><b:startEvent id="Start_1" /></b:process>
 <d:BPMNDiagram id="Diagram_1"><d:BPMNPlane id="Plane_1" bpmnElement="Process_1"><d:BPMNShape id="Shape_1" bpmnElement="Start_1"><c:Bounds x="200" y="120" width="36" height="36" /></d:BPMNShape></d:BPMNPlane></d:BPMNDiagram>
</b:definitions>
`.replace(/\n/g, '\r\n');
const initial: DiagramValue = {
  format: params.get('format') === 'bpmn' ? 'bpmn' : params.get('format') === 'drawio' ? 'drawio' : 'mermaid',
  title: 'Проверка диаграммы',
  source: params.get('format') === 'bpmn' ? params.get('existing') === '1' ? existingBpmn : '' : params.get('format') === 'drawio'
    ? '<mxfile><diagram id="first" name="Первая"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="Начало" vertex="1" parent="1"><mxGeometry x="80" y="80" width="160" height="64" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
    : params.get('class') === '1' ? 'classDiagram\nclass Item {\n int value\n}\nclass Box\nItem --> Box'
      : params.get('sequence') === '1' ? 'sequenceDiagram\nAlice->>Bob: Исходное сообщение'
      : 'flowchart LR\n  Start["Начало"] --> End["Конец"]'
};

function Harness(): React.JSX.Element {
  const [value, setValue] = useState(initial);
  const [session, setSession] = useState<DiagramSession | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [cancels, setCancels] = useState(0);
  const attemptsRef = useRef(0);
  const epoch = useRef(0);
  const open = (mode: DiagramSession['mode']): void => {
    setSession({ value, mode, key: String(++epoch.current) });
  };
  return <main className="vault-workspace" style={{ padding: 'var(--spacing)', display: 'block', height: '100dvh' }}>
    <h1>Проверка адаптера</h1>
    <Button onPress={() => open('create')}>Создать</Button>
    <Button onPress={() => open('edit')}>Редактировать</Button>
    <Button onPress={() => open('view')}>Открыть</Button>
    <output aria-label="Попытки сохранения">{attempts}</output>
    <output aria-label="Отмены">{cancels}</output>
    <pre hidden aria-label="Сохранённый исходник">{value.source}</pre>
    {value.source && <DiagramPreview value={value} onExpand={() => open('view')} onEdit={() => open('edit')} />}
    {session && <DiagramDialog session={session}
      onCancel={() => { setCancels((count) => count + 1); setSession(null); }}
      onSave={async (next) => {
        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        if (params.get('reject') === '1' && attemptsRef.current === 1) throw new TypeError('Конфликт документа: черновик оставлен.');
        setValue(next);
        setSession(null);
      }} />}
  </main>;
}

const container = document.getElementById('root');
if (!container) throw new TypeError('Не найден контейнер проверки.');
createRoot(container).render(<StrictMode><Harness /></StrictMode>);

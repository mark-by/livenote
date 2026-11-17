import { useEffect, useRef, useState } from 'react';
import Modeler from 'bpmn-js/lib/Modeler';
import type Canvas from 'diagram-js/lib/core/Canvas';
import type CommandStack from 'diagram-js/lib/command/CommandStack';
import type DirectEditing from 'diagram-js-direct-editing/lib/DirectEditing';
import type { DiagramSession } from './types';
import { bpmnTranslate } from './bpmnTranslate';

export function useBpmnModeler(session: DiagramSession, enabled: boolean) {
  const hostRef = useRef<HTMLDivElement>(null);
  const modelerRef = useRef<Modeler | null>(null);
  const dirtyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;
    const modeler = new Modeler({ container: host, additionalModules: [{ translate: ['value', bpmnTranslate] }] });
    modelerRef.current = modeler;
    let disposed = false;
    let imported = false;
    const stack = modeler.get<CommandStack>('commandStack');
    const changed = (): void => {
      if (!imported || disposed) return;
      // Undo до исходного состояния не требует повторной сериализации XML.
      dirtyRef.current = stack.canUndo();
      setDirty(dirtyRef.current);
      setHistory({ undo: stack.canUndo(), redo: stack.canRedo() });
    };
    modeler.on('commandStack.changed', changed);
    const load = session.mode === 'create' ? modeler.createDiagram() : modeler.importXML(session.value.source);
    void load.then(() => {
      if (disposed) return;
      stack.clear();
      imported = true;
      modeler.get<Canvas>('canvas').zoom('fit-viewport');
      setReady(true);
    }).catch((failure: unknown) => {
      if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => {
      disposed = true;
      modelerRef.current = null;
      modeler.destroy();
    };
    // Сессия неизменна до закрытия; новый key монтирует новый редактор.
  }, [session.key, enabled]);

  const xml = async (): Promise<string> => {
    const modeler = modelerRef.current;
    if (!modeler) throw new TypeError('Редактор BPMN закрыт.');
    modeler.get<DirectEditing>('directEditing').complete();
    if (session.mode !== 'create' && !dirtyRef.current) return session.value.source;
    const result = await modeler.saveXML({ format: true });
    if (typeof result.xml !== 'string') throw new TypeError('Редактор BPMN не вернул XML.');
    return result.xml;
  };

  return {
    hostRef, modelerRef, ready, dirty, history, error, setError, xml,
    undo: () => modelerRef.current?.get<CommandStack>('commandStack').undo(),
    redo: () => modelerRef.current?.get<CommandStack>('commandStack').redo(),
    fit: () => modelerRef.current?.get<Canvas>('canvas').zoom('fit-viewport')
  };
}

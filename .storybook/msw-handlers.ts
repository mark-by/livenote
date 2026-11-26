import { http, HttpResponse } from 'msw';
import { agentApiBase } from '../src/shared/agentChat';
import type { AgentBindingView } from '../src/shared/agentChat';

export const fixtureVaultId = 'storybook-vault';
const bindingPath = `${agentApiBase(fixtureVaultId)}/binding`;
const emptyBinding: AgentBindingView = {
  value: { repo: null, localDir: null },
  version: null,
};
const existingBinding: AgentBindingView = {
  value: {
    repo: { provider: 'gitlab', url: 'https://git.example/team/service.git', ref: 'release' },
    localDir: null,
  },
  version: 'sha256:storybook',
};

export const mswHandlers = [
  http.get(bindingPath, ({ request }) => {
    const folder = new URL(request.url).searchParams.get('folder');
    return HttpResponse.json(folder === 'Проект' ? existingBinding : emptyBinding);
  }),
  http.put(bindingPath, () => HttpResponse.json(existingBinding)),
  http.post(`${bindingPath}/pick`, () => HttpResponse.json({ localDir: '/fixture/service' })),
];

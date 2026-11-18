import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
// @ts-expect-error The distributable extension intentionally uses browser JSX.
import { Desk } from '../dsh-media-desk/client/index.jsx';
// @ts-expect-error The table is part of the distributable browser JSX.
import { ContentView } from '../dsh-media-desk/client/content.jsx';
// @ts-expect-error The canvas is part of the distributable browser JSX.
import { HomeView } from '../dsh-media-desk/client/canvas.jsx';
// @ts-expect-error Extension state is plain JavaScript shared with its worker.
import { getDesk, setDesk } from '../dsh-media-desk/client/desk.js';
// @ts-expect-error Exercise the shipped DomainRuntime, not a second state implementation.
import { createDomainRuntime } from '../dsh-media-desk/domain.mjs';
// @ts-expect-error Upstream locale is JavaScript, driven by the SDK in Electron.
import { setLanguagePreference } from '../dsh-media-desk/client/i18n.js';

function canvasPointer(target: Element | Window, type: string, x: number, pointerId = 7) {
  const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 20 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(target, event);
}

it.each(['cancel-card', 'cancel-pan', 'switch-view', 'release-card'])('settles the canvas pointer sequence (%s)', async (action) => {
  const previous = getDesk();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  setLanguagePreference('zh');
  setDesk({
    state: { items: [{ id: 'drag-item', title: '拖动的灵感', kind: 'note', status: 'idea', createdAt: '2026-11-16T00:00:00Z', pos: { x: 50, y: 100, r: 0 } }] },
    mode: 'scatter', kindFilter: 'all', related: null, focusId: null,
  });
  const command = vi.fn(async () => ({ result: { state: getDesk().state } }));
  const deskWindow = window as unknown as { ma?: unknown };
  const previousSdk = deskWindow.ma;
  deskWindow.ma = { ready: Promise.resolve({}), agent: { domain: { command } } };
  const view = render(<HomeView />);
  try {
    const stage = view.container.querySelector<HTMLElement>('.md-stage')!;
    const node = stage.querySelector<HTMLElement>('[data-node="drag-item"]')!;
    const world = stage.querySelector<HTMLElement>('.md-world')!;
    const initialLeft = node.style.left;
    const initialTransform = world.style.transform;
    if (action === 'cancel-pan') {
      canvasPointer(stage, 'pointerdown', 10);
      canvasPointer(window, 'pointermove', 90);
      expect(world.style.transform).not.toBe(initialTransform);
      expect(stage.classList.contains('is-panning')).toBe(true);
      canvasPointer(window, 'pointercancel', 90);
      const stoppedTransform = world.style.transform;
      expect(stage.classList.contains('is-panning')).toBe(false);
      canvasPointer(window, 'pointermove', 160);
      expect(world.style.transform).toBe(stoppedTransform);
      return;
    }
    canvasPointer(node, 'pointerdown', 10);
    canvasPointer(window, 'pointermove', 90);
    expect(node.style.left).not.toBe(initialLeft);
    expect(node.classList.contains('is-dragging')).toBe(true);
    if (action === 'release-card') {
      const draggedLeft = Number.parseFloat(node.style.left);
      canvasPointer(window, 'pointerup', 90, 8);
      expect(node.classList.contains('is-dragging')).toBe(true);
      canvasPointer(window, 'pointerup', 90);
      await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
      expect(command.mock.calls[0]).toEqual(['desk.write', expect.objectContaining({
        path: 'ops',
        body: expect.objectContaining({ ops: [{ op: 'update_item', id: 'drag-item', pos: { x: Math.round(draggedLeft), y: 100, r: 0 } }] }),
      })]);
      expect(node.classList.contains('is-dragging')).toBe(false);
      return;
    }
    if (action === 'switch-view') {
      fireEvent.click(screen.getByTitle('信息流'));
      expect(stage.isConnected).toBe(false);
    } else {
      canvasPointer(window, 'pointercancel', 90);
    }
    await act(async () => { canvasPointer(window, 'pointermove', 160); canvasPointer(window, 'pointerup', 160); });
    expect(command).not.toHaveBeenCalled();
    expect(node.style.left).toBe(initialLeft);
    expect(node.classList.contains('is-dragging')).toBe(false);
  } finally {
    await act(async () => { canvasPointer(window, 'pointerup', 90); });
    view.unmount();
    deskWindow.ma = previousSdk;
    setDesk(previous);
    vi.unstubAllGlobals();
  }
});

it('opens a content table item with a native keyboard action and with a click on the row', async () => {
  const previous = getDesk();
  setLanguagePreference('zh');
  setDesk({
    state: { items: [{ id: 'content-row', title: '创作选题', kind: 'note', status: 'idea', createdAt: '2026-11-16T00:00:00Z' }] },
    query: '', focusId: null,
  });
  const user = userEvent.setup();
  const view = render(<ContentView />);
  try {
    await user.click(screen.getByRole('radio', { name: '表格' }));
    const cell = screen.getByRole('cell', { name: /创作选题/ });
    const row = cell.closest('tr')!;
    const button = within(cell).getByRole('button', { name: /^创作选题/ });
    expect(button.tagName).toBe('BUTTON');
    expect(row.tabIndex).toBe(-1);
    const reveal = vi.fn();
    button.scrollIntoView = reveal;
    button.focus();
    expect(reveal).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    await user.keyboard(' ');
    expect(getDesk().focusId).toBe('content-row');
    act(() => setDesk({ focusId: null }));
    await user.keyboard('{Enter}');
    expect(getDesk().focusId).toBe('content-row');
    act(() => setDesk({ focusId: null }));
    await user.click(within(row).getAllByRole('cell')[1]);
    expect(getDesk().focusId).toBe('content-row');
  } finally {
    view.unmount();
    setDesk(previous);
  }
});

it('preserves the upstream five-page workspace, capture/undo and studio interactions', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  setLanguagePreference('zh');
  const data = new Map<string, string>([['media-desk/settings.json', JSON.stringify({ language: 'zh' })]]);
  const runtime = createDomainRuntime({ identity: { workspaceId: 'test' }, broker: async (method: string, args: string[]) => {
    if (method === 'models.list') return [];
    if (method === 'models.customImage') return { asset: { assetId: 'preview', url: 'https://example.invalid/preview.png' } };
    if (method === 'models.sealImageKey') return 'encrypted-test-key';
    if (method === 'data.read') return data.has(args[0]) ? { content: data.get(args[0]) } : null;
    if (method === 'data.write') { data.set(args[0], args[1]); return true; }
    throw new Error(`Unexpected broker method ${method}`);
  } });
  const events = new Map<string, (event: { actor: string }) => void>();
  (window as unknown as { ma: unknown }).ma = { ready: Promise.resolve({}), on: (topic: string, callback: (event: { actor: string }) => void) => { events.set(topic, callback); return () => events.delete(topic); }, models: { list: async () => [] }, agent: { domain: {
    snapshot: () => runtime.getSnapshot(), query: (name: string, args: unknown) => runtime.query(name, args), command: (name: string, args: unknown) => runtime.execute(name, args)
  } } };
  setDesk({ state: null, error: null, focusId: null, capture: null, dialog: null, settingsOpen: false, modelPickOpen: false, view: 'home', mode: 'scatter', dockOpen: false });
  const view = render(<Desk />);
  try {
    await screen.findByRole('textbox', { name: '记下灵感' });
    expect(view.container.querySelectorAll('.md-node').length).toBeGreaterThan(10);
    const initial = getDesk().state.items.length;
    fireEvent.change(screen.getByRole('textbox', { name: '记下灵感' }), { target: { value: '一条用于原版画布回归的灵感' } });
    fireEvent.submit(view.container.querySelector('.md-hero-input')!);
    await waitFor(() => expect(getDesk().state.items.length).toBe(initial + 1));
    fireEvent.click(screen.getByRole('button', { name: '撤销上一步' }));
    await waitFor(() => expect(getDesk().state.items.length).toBe(initial));
    const nav = screen.getByRole('navigation', { name: '工作台导航' });
    for (const page of ['内容', '排期', '复盘', '风格', '灵感']) {
      fireEvent.click(within(nav).getByRole('button', { name: page }));
      await waitFor(() => expect(within(nav).getByRole('button', { name: page }).getAttribute('aria-current')).toBe('page'));
    }
    fireEvent.click(within(nav).getByRole('button', { name: '风格' }));
    fireEvent.click(screen.getByRole('button', { name: '抓我的账号' }));
    const monid = await screen.findByRole('dialog', { name: '连接 Monid' });
    await within(monid).findByText(/当前尚未接入 Monid/);
    expect(within(monid).queryByText('我装好了，检查一下')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '连接 Monid' })).toBeNull());
    fireEvent.click(within(nav).getByRole('button', { name: '灵感' }));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = await screen.findByRole('dialog', { name: '设置' });
    const draftImage = async () => {
      const providers = within(await within(settings).findByRole('group', { name: '服务商' }));
      expect(providers.getAllByRole('button')).toHaveLength(6);
      fireEvent.click(providers.getByRole('button', { name: 'OpenAI' }));
      expect((within(settings).getByRole('textbox', { name: /接口地址/ }) as HTMLInputElement).value).toBe('https://api.openai.com/v1');
      expect((within(settings).getByRole('textbox', { name: '生图模型' }) as HTMLInputElement).value).toBe('chatgpt-image-latest');
      fireEvent.change(within(settings).getByLabelText('密钥'), { target: { value: 'first-provider-only' } });
      fireEvent.click(providers.getByRole('button', { name: '火山方舟' }));
      expect((within(settings).getByLabelText('密钥') as HTMLInputElement).value).toBe('');
      expect((within(settings).getByRole('textbox', { name: '生图模型' }) as HTMLInputElement).value).toBe('');
      fireEvent.click(providers.getByRole('button', { name: '其他自定义' }));
      fireEvent.change(await within(settings).findByRole('textbox', { name: /接口地址/ }), { target: { value: 'https://example.invalid/v1' } });
      fireEvent.change(within(settings).getByRole('textbox', { name: '生图模型' }), { target: { value: 'image-model' } });
      expect(providers.getByRole('button', { name: '其他自定义' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.change(within(settings).getByLabelText('密钥'), { target: { value: 'test-only-api-key' } });
    };
    await draftImage();
    fireEvent.click(within(settings).getByRole('button', { name: '试画一张' }));
    expect(await within(settings).findByRole('img', { name: '测试图' })).toBeTruthy();
    expect(data.get('media-desk/settings.json')).toBe(JSON.stringify({ language: 'zh' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull());
    await act(async () => setDesk({ focusId: getDesk().state.items[0].id }));
    expect(await screen.findByRole('dialog', { name: '灵感' })).toBeTruthy();
    expect(view.container.querySelector('.md-bento')).toBeTruthy();
    const itemId = getDesk().focusId;
    fireEvent.click(screen.getByRole('button', { name: '一键成稿' }));
    await screen.findByRole('button', { name: '重新成稿' });
    const hero = within(view.container.querySelector<HTMLElement>('.md-hero-actions')!);
    fireEvent.click(hero.getByText('排期'));
    const editor = await screen.findByRole('dialog', { name: '修改排期' });
    const dateTime = '2030-06-15T14:30';
    fireEvent.change(within(editor).getByLabelText(/^发布时间/), { target: { value: dateTime } });
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }));
    const scheduled = () => getDesk().state.items.find((item: { id: string }) => item.id === itemId).scheduledAt;
    await waitFor(() => expect(scheduled()).toBe(new Date(dateTime).toISOString()));
    const reopen = () => fireEvent.click(hero.getByRole('button', { name: /14:30/ }));
    reopen();
    const edit = await screen.findByRole('dialog', { name: '修改排期' });
    expect((within(edit).getByLabelText(/^发布时间/) as HTMLInputElement).value).toBe(dateTime);
    fireEvent.change(within(edit).getByLabelText(/^发布时间/), { target: { value: '' } });
    fireEvent.click(within(edit).getByRole('button', { name: '取消' }));
    expect(scheduled()).toBe(new Date(dateTime).toISOString());
    reopen();
    const clear = await screen.findByRole('dialog', { name: '修改排期' });
    fireEvent.change(within(clear).getByLabelText(/^发布时间/), { target: { value: '' } });
    fireEvent.click(within(clear).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(scheduled()).toBeFalsy());
    fireEvent.click(screen.getByRole('button', { name: '返回灵感' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '灵感' })).toBeNull());
    await runtime.execute('desk.write', { path: 'ops', body: { ops: [{ op: 'add_item', kind: 'note', title: '外部助手写入的灵感' }] }, language: 'zh' });
    await act(async () => events.get('desk.changed')?.({ actor: 'agent' }));
    await waitFor(() => expect(getDesk().state.items.some((item: { title: string }) => item.title === '外部助手写入的灵感')).toBe(true));
  } finally { view.unmount(); await runtime.close(); vi.unstubAllGlobals(); }
});

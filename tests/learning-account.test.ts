import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { PlatformAccessError } from '../src/platform-access';
import type { FrameRef } from '../src/background/transport';

const mock = vi.hoisted(() => ({ state: undefined as any }));
vi.mock('../src/background/store', () => mock);
vi.mock('../src/background/platform', () => ({
  assertPlatformReady: vi.fn(),
  holdPlatform: vi.fn(),
}));
vi.mock('../src/background/operations', () => ({
  operationEvent: vi.fn(),
  heartbeatOperation: vi.fn(),
}));
import {
  discoverAccountFrames,
  discoverFrames,
  isLiveAccountWitness,
} from '../src/background/learning-frame-access';
import {
  frames,
  invalidateLearningFrames,
  notifyFrameRegistry,
} from '../src/background/transport';
import { checkFrames } from '../src/background/scan-control';

const resource = (): FrameRef => ({
  tabId: 10,
  frameId: 0,
  documentId: 'course-document',
  url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=100',
  top: true,
  loginRequired: false,
});
const personalCenter = (): FrameRef => ({
  tabId: 20,
  frameId: 0,
  documentId: 'personal-document',
  url: 'https://i.chaoxing.com/base?ws=2',
  top: true,
  loginRequired: false,
  accountId: 'cx:1',
});
let target: FrameRef[], witnesses: FrameRef[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.state = initialState();
  mock.state.accountId = 'cx:1';
  frames.clear();
  invalidateLearningFrames(10);
  invalidateLearningFrames(20);
  target = [resource()];
  witnesses = [personalCenter()];
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: 10 }, { id: 20 }]),
      sendMessage: vi.fn(async (tabId, _command, options) => {
        const ref = (tabId === 10 ? target : witnesses).find(
          (f) => f.documentId === options.documentId,
        );
        if (!ref) throw new Error('Receiving end does not exist');
        return { ok: true, value: { ...ref } };
      }),
    },
    webNavigation: {
      getAllFrames: vi.fn(async ({ tabId }) =>
        (tabId === 10 ? target : witnesses).map((ref) => ({ ...ref })),
      ),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('forces a fresh description within the one-second cache window after an empty identity', async () => {
  frames.set('10:0', resource());
  notifyFrameRegistry(10);
  target[0]!.accountId = 'cx:1';
  const pending = discoverAccountFrames(10, 'cx:1');
  await vi.advanceTimersByTimeAsync(251);
  expect((await pending)[0]!.accountId).toBe('cx:1');
  expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledOnce();
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it('honors explicit cache bypass instead of returning stale registered frames', async () => {
  frames.set('10:0', resource());
  notifyFrameRegistry(10);
  target[0]!.accountId = 'cx:1';
  expect((await discoverFrames(10, undefined, false))[0]!.accountId).toBe('cx:1');
  expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledOnce();
});

it('uses a fresh matching personal center for anonymous course frames and returns only the target', async () => {
  const pending = discoverAccountFrames(10, 'cx:1');
  await vi.advanceTimersByTimeAsync(1000);
  const result = await pending;
  expect(result).toEqual(target);
  expect(result.every((f) => f.tabId === 10)).toBe(true);
  expect(chrome.tabs.query).toHaveBeenCalledOnce();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    20,
    expect.objectContaining({ command: { op: 'describe' } }),
    { documentId: 'personal-document' },
  );
});

it('does not accept the saved account or a stale personal-center registration as live evidence', async () => {
  frames.set('20:0', personalCenter());
  witnesses = [];
  const pending = discoverAccountFrames(10, 'cx:1').catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ code: 'account-unconfirmed' });
});

it('does not use another tab to validate an unreadable target', async () => {
  target = [];
  const pending = discoverAccountFrames(10, 'cx:1').catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ code: 'account-unconfirmed' });
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it('stops immediately when the target is logged out despite a matching cookie identity', async () => {
  Object.assign(target[0]!, { loginRequired: true, accountId: 'cx:1' });
  await expect(discoverAccountFrames(10, 'cx:1')).rejects.toMatchObject({
    code: 'login-required',
  });
  expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledOnce();
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it('does not retry an account change or mislabel it as missing identity', async () => {
  target[0]!.accountId = 'cx:2';
  await expect(discoverAccountFrames(10, 'cx:1')).rejects.toMatchObject({
    code: 'account-changed',
    message: expect.stringContaining('登录账号已变化'),
  });
  expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledOnce();
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it('rejects a live personal center belonging to another account', async () => {
  witnesses[0]!.accountId = 'cx:2';
  const pending = discoverAccountFrames(10, 'cx:1').catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ code: 'account-changed' });
});

it('rechecks the target after reading a witness and detects navigation to a different account', async () => {
  const describe = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()! as unknown as (
    tabId: number,
    message: unknown,
    options: unknown,
  ) => Promise<unknown>;
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async (tabId, message, options: any) => {
    const response = await describe(tabId, message, options);
    if (tabId === 20) target[0]!.accountId = 'cx:2';
    return response;
  });
  const pending = discoverAccountFrames(10, 'cx:1').catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ code: 'multiple-accounts' });
});

it('stops on a verification page without retry or identity fallback', async () => {
  target[0]!.verificationRequired = true;
  await expect(discoverAccountFrames(10, 'cx:1')).rejects.toBeInstanceOf(
    PlatformAccessError,
  );
  expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledOnce();
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it('cancels identity recovery without probing another tab', async () => {
  const controller = new AbortController();
  const pending = discoverAccountFrames(10, 'cx:1', controller.signal).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(10);
  controller.abort(new Error('操作已取消'));
  expect((await pending).message).toContain('取消');
  await vi.advanceTimersByTimeAsync(2000);
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it.each([
  { url: 'https://other.test/base' },
  { url: 'https://mooc1.chaoxing.com/base' },
  { url: 'https://i.chaoxing.com/space/teacher' },
  { top: false },
  { documentId: undefined },
  { loginRequired: true },
  { verificationRequired: true },
])('rejects an untrusted account witness %j', (change) => {
  expect(isLiveAccountWitness({ ...personalCenter(), ...change })).toBe(false);
});

it('keeps global scan identity valid when an unrelated old login tab remains open', () => {
  expect(() =>
    checkFrames([personalCenter(), { ...resource(), loginRequired: true }]),
  ).not.toThrow();
});

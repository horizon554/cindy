// @vitest-environment jsdom
/**
 * PermissionPrompt.test.tsx — 权限卡片的档位切换入口。
 *
 * 卡片顶替 composer 时 ChatInput 不挂载,composer 上的权限 chip 和 Shift+Tab 轮切
 * 一起失效,用户在连续授权里没法切到自动放行。这里锁死补上的那条路:
 *   - 不传 modeSwitch 时卡片与改造前一致(chip 不出现);
 *   - 本组件自己**不** onRespond —— 当前 pending 由 maker-core 的 dismissAllPending
 *     按新档结掉(放宽→allow,其它→deny),渲染层不得再叠一次回应;
 *   - 远程断链(disabled)时 chip 与快捷键一起停用;
 *   - 模态(Full access 二次确认)里的按键不穿透成 Allow/Deny;
 *   - 原有 Enter / Ctrl+Enter / Esc 语义不被轮切分支挤掉。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionModeDescriptor } from '@/hooks/useAgentCapabilities';
import type { PendingPermission } from '@/lib/makerChatStore';

// 真实 PermissionSelector 会拉 capabilities / i18n / MorphPopover;这里只验它被挂上、
// 拿到了当前档,弹层与配色由 PermissionSelector 自己的用例负责。
vi.mock('../PermissionSelector', () => ({
  PermissionSelector: ({ permissionMode }: { permissionMode: string }) => (
    <div data-testid="permission-chip">{permissionMode}</div>
  ),
}));

import { PermissionPrompt } from '../PermissionPrompt';

afterEach(cleanup);

const PERMISSION: PendingPermission = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'curl -s https://example.com' },
};

const CYCLE_OPTIONS: PermissionModeDescriptor[] = [
  { id: 'ask', displayName: '询问' },
  { id: 'acceptEdits', displayName: '自动接受编辑' },
  { id: 'bypassPermissions', displayName: '完全访问' },
];

/** registry 默认绑定:Shift+Tab(matchesKeyboardEvent 按 event.code 判定)。 */
function pressCyclePermissionMode() {
  fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', shiftKey: true });
}

describe('PermissionPrompt modeSwitch', () => {
  it('不传 modeSwitch 时不渲染档位 chip', () => {
    render(<PermissionPrompt permission={PERMISSION} onRespond={vi.fn()} />);

    expect(screen.queryByTestId('permission-chip')).toBeNull();
    expect(screen.getByText('Allow once')).toBeTruthy();
  });

  it('传入时把当前档挂到卡片上', () => {
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={vi.fn()}
        modeSwitch={{
          permissionMode: 'acceptEdits',
          onPermissionModeChange: vi.fn(),
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    expect(screen.getByTestId('permission-chip').textContent).toBe('acceptEdits');
  });

  it('Shift+Tab 轮到下一档,渲染层自身不 onRespond(pending 归 maker-core 结)', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    pressCyclePermissionMode();

    expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('可用档不足 2 个时不消费按键', () => {
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={vi.fn()}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: [{ id: 'ask', displayName: '询问' }],
        }}
      />,
    );

    pressCyclePermissionMode();

    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  it('远程断链(disabled)时快捷键轮切一并停用', () => {
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={vi.fn()}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
          disabled: true,
        }}
      />,
    );

    pressCyclePermissionMode();

    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  // 切 Full access 会在卡片仍挂载时弹二次确认框。确认框聚焦的是普通 <button>,
  // 不挡就会让确认框上的 Enter/Esc 顺带回答掉这条工具请求。
  it('模态内的 Enter / Esc 不穿透到卡片动作', () => {
    const onRespond = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange: vi.fn(),
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    const cancelButton = document.createElement('button');
    dialog.appendChild(cancelButton);
    document.body.appendChild(dialog);

    fireEvent.keyDown(cancelButton, { key: 'Enter', code: 'Enter', bubbles: true });
    fireEvent.keyDown(cancelButton, { key: 'Escape', code: 'Escape', bubbles: true });

    expect(onRespond).not.toHaveBeenCalled();
    document.body.removeChild(dialog);
  });

  it('没有 modeSwitch 时 Shift+Tab 不做任何事', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={PERMISSION} onRespond={onRespond} />);

    pressCyclePermissionMode();

    expect(onRespond).not.toHaveBeenCalled();
  });

  it('轮切分支不影响 Enter / Esc 的既有语义', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    const { rerender } = render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow' });

    onRespond.mockClear();
    rerender(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'deny', decisionClassification: 'user_reject' }),
    );
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });
});

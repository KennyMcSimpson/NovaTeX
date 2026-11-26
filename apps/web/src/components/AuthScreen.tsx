import React, { useState } from 'react';
import type { UserPublic } from '@novatex/shared';
import {
  Eye,
  EyeOff,
  FileCode2,
  FlaskConical,
  Globe,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { api, type AuthMeResponse } from '../api.ts';
import { useLocale } from '../i18n.ts';
import { BrandMark } from './BrandMark.tsx';

export interface AuthScreenProps {
  authMeta: AuthMeResponse;
  inviteToken: string | null;
  onAuthenticated: (user: UserPublic, acceptedProjectId?: string) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  authMeta,
  inviteToken,
  onAuthenticated,
}) => {
  const { locale, setLocale, tr } = useLocale();

  const isSetup = authMeta.needsSetup;
  const canRegister = !isSetup && (authMeta.allowPublicRegister || Boolean(inviteToken));

  const [mode, setMode] = useState<'login' | 'register'>(
    inviteToken ? 'register' : 'login',
  );
  const effectiveMode = canRegister ? mode : 'login';

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegistrationFlow = isSetup || effectiveMode === 'register';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setError(tr('Please enter both username and password.', '请填写用户名和密码。'));
      return;
    }

    if (isRegistrationFlow) {
      if (password.length < 6) {
        setError(tr('Password must be at least 6 characters.', '密码长度至少需要 6 位。'));
        return;
      }
      if (password !== confirmPassword) {
        setError(tr('Passwords do not match.', '两次输入的密码不一致。'));
        return;
      }
    }

    setSubmitting(true);
    try {
      if (isSetup) {
        const res = await api.setupAdmin({
          username: trimmedUser,
          displayName: displayName.trim() || trimmedUser,
          password,
        });
        onAuthenticated(res.user);
        return;
      }

      // Single-step invite registration invariant: pass inviteToken directly to register()
      if (effectiveMode === 'register') {
        const res = await api.register({
          username: trimmedUser,
          displayName: displayName.trim() || trimmedUser,
          password,
          inviteToken: inviteToken ?? undefined,
        });
        onAuthenticated(res.user, res.projectId);
        return;
      }

      const res = await api.login({ username: trimmedUser, password });
      let acceptedProjectId: string | undefined;
      if (inviteToken) {
        try {
          const acc = await api.acceptInvite(inviteToken);
          acceptedProjectId = acc.projectId ?? acc.project?.id;
        } catch {
          // Ignore if already a member
        }
      }
      onAuthenticated(res.user, acceptedProjectId);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : tr('Authentication request failed', '认证请求失败'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div
          className="auth-logo"
          style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <BrandMark size={34} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 17,
                  lineHeight: 1.2,
                  letterSpacing: '-0.025em',
                  color: 'var(--text-primary)',
                }}
              >
                NovaTeX
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                {tr('Multi-Format LaTeX & Lab Report Studio', '多格式 LaTeX 与实验报告写作台')}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-xs"
            style={{
              flexShrink: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '0 8px',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
            }}
            aria-label={tr('Switch interface language', '切换界面语言')}
            title={tr('Switch language (EN / ZH)', '切换中英文界面')}
            onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}
          >
            <Globe size={11.5} />
            <span>{locale === 'en' ? 'EN / ZH' : 'EN / 中文'}</span>
          </button>
        </div>

        {isSetup ? (
          <>
            <h1 className="auth-title">{tr('Initialize Admin Account', '初始化管理员账号')}</h1>
            <p className="auth-subtitle">
              {tr(
                'First launch of NovaTeX. Create your administrator account — all source files and workspace data remain on your local server.',
                '首次启动 NovaTeX，请创建管理员账户。所有源码与项目数据均保存在本地服务器。',
              )}
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">
              {inviteToken
                ? tr('Accept Project Invite', '受邀加入项目')
                : effectiveMode === 'login'
                  ? tr('Sign In to Studio', '登录工作台')
                  : tr('Create Account', '注册新账号')}
            </h1>
            <p className="auth-subtitle">
              {inviteToken
                ? tr(
                    'Sign in or register to join this workspace automatically.',
                    '完成注册或登录后将自动加入该项目空间。',
                  )
                : effectiveMode === 'login'
                  ? tr(
                      'Enter your credentials to continue writing and live PDF compilation.',
                      '输入账户凭据以继续文档写作与实时编译。',
                    )
                  : tr(
                      'Create a personal account with your own scoped BYOK AI configuration.',
                      '创建个人账号，支持绑定专属 AI 引擎配置。',
                    )}
            </p>
          </>
        )}

        {inviteToken && !isSetup && (
          <div
            className="alert alert-accent"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              padding: '8px 11px',
            }}
          >
            <UserPlus size={14} style={{ flexShrink: 0 }} />
            <span>
              {tr(
                `Project invite token ready (${inviteToken.slice(0, 10)}…)`,
                `项目邀请令牌已就绪（${inviteToken.slice(0, 10)}…）`,
              )}
            </span>
          </div>
        )}

        {!isSetup && canRegister && (
          <div className="tab-bar" role="tablist" aria-label={tr('Sign in or register', '登录或注册')}>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === 'login'}
              className={`tab-btn ${effectiveMode === 'login' ? 'active' : ''}`}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              {tr('Sign In', '登录')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === 'register'}
              className={`tab-btn ${effectiveMode === 'register' ? 'active' : ''}`}
              onClick={() => {
                setMode('register');
                setError(null);
              }}
            >
              {inviteToken
                ? tr('Register with Invite', '受邀注册新账号')
                : tr('Create Account', '注册新账号')}
            </button>
          </div>
        )}

        {error && <div className="alert alert-danger">{error}</div>}

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="field">
            <label className="field-label" htmlFor="auth-username">
              {tr('Username', '用户名')}
            </label>
            <input
              id="auth-username"
              className="input"
              autoFocus
              autoComplete="username"
              placeholder={tr('e.g. alice', '例如 alice')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          {isRegistrationFlow && (
            <div className="field">
              <label className="field-label" htmlFor="auth-display">
                {tr('Display Name', '显示昵称')}
              </label>
              <input
                id="auth-display"
                className="input"
                placeholder={tr('e.g. Alice Chen', '例如 张三 / Alice')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="auth-password">
              {tr('Password', '密码')}
            </label>
            <div className="input-group">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                className="input"
                autoComplete={isRegistrationFlow ? 'new-password' : 'current-password'}
                placeholder={
                  isRegistrationFlow
                    ? tr('At least 6 characters', '至少 6 位密码')
                    : tr('Enter password', '输入密码')
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="input-group-actions">
                <button
                  type="button"
                  className="input-addon-btn"
                  aria-label={showPassword ? tr('Hide password', '隐藏密码') : tr('Show password', '显示密码')}
                  title={showPassword ? tr('Hide password', '隐藏密码') : tr('Show password', '显示密码')}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
          </div>

          {isRegistrationFlow && (
            <div className="field">
              <label className="field-label" htmlFor="auth-confirm">
                {tr('Confirm Password', '确认密码')}
              </label>
              <div className="input-group">
                <input
                  id="auth-confirm"
                  type={showConfirmPassword ? 'text' : 'password'}
                  className="input"
                  autoComplete="new-password"
                  placeholder={tr('Re-enter password', '再次输入密码')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <div className="input-group-actions">
                  <button
                    type="button"
                    className="input-addon-btn"
                    aria-label={
                      showConfirmPassword
                        ? tr('Hide confirm password', '隐藏确认密码')
                        : tr('Show confirm password', '显示确认密码')
                    }
                    title={
                      showConfirmPassword
                        ? tr('Hide confirm password', '隐藏确认密码')
                        : tr('Show confirm password', '显示确认密码')
                    }
                    onClick={() => setShowConfirmPassword((v) => !v)}
                  >
                    {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', height: 38, marginTop: 6, fontSize: 13 }}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 size={15} className="spin" />
            ) : isSetup ? (
              <ShieldCheck size={15} />
            ) : (
              <KeyRound size={15} />
            )}
            {isSetup
              ? tr('Create Admin & Enter Studio', '创建管理员并进入工作台')
              : effectiveMode === 'register'
                ? inviteToken
                  ? tr('Register & Join Project', '注册并加入项目')
                  : tr('Create Account', '注册新账号')
                : inviteToken
                  ? tr('Sign In & Join Project', '登录并加入项目')
                  : tr('Sign In to Studio', '登录工作台')}
          </button>
        </form>

        <div
          style={{
            marginTop: 20,
            paddingTop: 14,
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: '6px 8px',
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FileCode2 size={12} style={{ opacity: 0.78 }} />
            LaTeX · MD · Word · PDF
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FlaskConical size={12} style={{ opacity: 0.78 }} />
            {tr('Lab Toolkit', '实验报告工具箱')}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Sparkles size={12} style={{ opacity: 0.78 }} />
            {tr('Scoped BYOK AI', '个人 AI 引擎')}
          </span>
        </div>
      </div>
    </div>
  );
};

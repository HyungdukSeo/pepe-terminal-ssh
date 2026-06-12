// src/components/QuickConnectDialog.tsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidHost, normalizeHost } from '../utils/hostValidate';

export type QuickConnectResult = {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: { type: 'password'; password: string };
  encoding: string;
  protocol: 'ssh' | 'sftp' | 'telnet';
};

type Props = {
  onConnect: (s: QuickConnectResult) => void;
  onCancel: () => void;
  forceProtocol?: 'ssh' | 'sftp';
};

export const QuickConnectBar: React.FC<Props> = ({ onConnect, onCancel, forceProtocol }) => {
  const { t } = useTranslation('quickConnect');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [encoding, setEncoding] = useState(() => localStorage.getItem('quickConnectEncoding') || 'utf-8');
  const [showPassword, setShowPassword] = useState(false);
  const [protocolState, setProtocol] = useState<'ssh' | 'sftp'>(() => (localStorage.getItem('quickConnectProtocol') as 'ssh' | 'sftp') || 'ssh');
  const protocol = forceProtocol ?? protocolState;

  const hostValid = host.trim() === '' || isValidHost(host);
  // 호스트만 있으면 연결 시도 — username/password 빠진 건 입력 모달에서 물어봄
  const canConnect = !!host.trim() && hostValid;

  const submit = () => {
    if (!canConnect) return;
    localStorage.setItem('quickConnectEncoding', encoding);
    localStorage.setItem('quickConnectProtocol', protocol);
    const normHost = normalizeHost(host);
    const u = username.trim();
    onConnect({
      name: u ? `${u}@${normHost}` : normHost,
      host: normHost,
      port: Number(port) || 22,
      username: u,
      auth: { type: 'password', password },
      encoding,
      protocol,
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    // Esc 는 무시 — 닫기는 ✕ 버튼으로만
  };

  return (
    <div className="quick-connect-bar" onKeyDown={onKey}>
      <button className="quick-connect-close" onClick={onCancel} title={t('close')}>✕</button>
      <span className="quick-connect-label">{t('label')}</span>
      <select
        className="quick-connect-input quick-connect-proto"
        value={protocol}
        onChange={e => setProtocol(e.target.value as 'ssh' | 'sftp')}
        disabled={!!forceProtocol}
        title={forceProtocol ? t('sftpFixed') : t('protocolTitle')}
      >
        <option value="ssh">SSH</option>
        <option value="sftp">SFTP</option>
      </select>
      <input
        className={`quick-connect-input quick-connect-host ${hostValid ? '' : 'invalid'}`}
        placeholder={t('hostPlaceholder')}
        value={host}
        onChange={e => setHost(e.target.value)}
        title={hostValid ? '' : t('hostInvalid')}
      />
      <span className="quick-connect-sep">:</span>
      <input
        className="quick-connect-input quick-connect-port"
        placeholder="22"
        value={port}
        onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ''))}
      />
      <input
        className="quick-connect-input quick-connect-user"
        placeholder={t('username')}
        value={username}
        onChange={e => setUsername(e.target.value)}
      />
      <div className="quick-connect-pw-wrap">
        <input
          className="quick-connect-input quick-connect-pw"
          type={showPassword ? 'text' : 'password'}
          placeholder={t('password')}
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <button
          type="button"
          className="quick-connect-eye"
          onClick={() => setShowPassword(p => !p)}
          title={showPassword ? t('hidePassword') : t('showPassword')}
        >
          {showPassword ? '🙈' : '👁'}
        </button>
      </div>
      <select
        className="quick-connect-input quick-connect-enc"
        value={encoding}
        onChange={e => setEncoding(e.target.value)}
        title={t('encoding')}
      >
        <option value="utf-8">utf-8</option>
        <option value="cp949">cp949</option>
        <option value="euc-kr">euc-kr</option>
        <option value="latin1">latin1</option>
      </select>
      <button
        className="quick-connect-go"
        onClick={submit}
        disabled={!canConnect}
      >
        {t('connect')}
      </button>
    </div>
  );
};

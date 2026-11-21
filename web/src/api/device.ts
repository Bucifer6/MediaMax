import type { DeviceInfo, Platform } from '@mediamax/shared';

const DEVICE_KEY = 'mm.deviceId';
export const APP_VERSION = '0.1.0';

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'ephemeral-' + randomId();
  }
}

function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

function osName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

export function getDeviceName(): string {
  const os = osName();
  return `${browserName()}${os ? ' on ' + os : ''}`;
}

export const PLATFORM: Platform = 'web';

export function deviceInfo(): DeviceInfo {
  return { deviceId: getDeviceId(), deviceName: getDeviceName(), platform: PLATFORM, appVersion: APP_VERSION };
}

export function deviceHeaders(): Record<string, string> {
  return {
    'X-Kinora-Device-Id': getDeviceId(),
    'X-Kinora-Device-Name': getDeviceName(),
    'X-Kinora-Platform': PLATFORM,
    'X-Kinora-Version': APP_VERSION,
  };
}

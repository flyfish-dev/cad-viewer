export type DwgRelease = 'R12' | 'R13' | 'R14' | 'R2000' | 'R2004' | 'R2007' | 'R2010' | 'R2013' | 'R2018' | 'UNKNOWN';

export interface DwgVersionInfo {
  signature: string;
  release: DwgRelease;
  supportedByOpenDesignSpec: boolean;
  notes?: string;
}

const RELEASES: Record<string, DwgRelease> = {
  AC1009: 'R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'R2000',
  AC1018: 'R2004',
  AC1021: 'R2007',
  AC1024: 'R2010',
  AC1027: 'R2013',
  AC1032: 'R2018'
};

export function readDwgVersion(bytes: Uint8Array): DwgVersionInfo {
  const signature = Array.from(bytes.slice(0, 6), (b) => String.fromCharCode(b)).join('');
  const release = RELEASES[signature] ?? 'UNKNOWN';
  return {
    signature,
    release,
    supportedByOpenDesignSpec: release !== 'UNKNOWN',
    notes: release === 'UNKNOWN' ? 'Unknown or unsupported DWG signature.' : undefined
  };
}

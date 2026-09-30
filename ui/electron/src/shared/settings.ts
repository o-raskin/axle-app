export type DesktopSettings = {
  launchFullscreen: boolean;
};

export const defaultDesktopSettings: DesktopSettings = {
  launchFullscreen: false
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;

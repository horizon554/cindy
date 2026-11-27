export interface PickerBrand { kind: string; monogram: string; customSvg?: string }
export function brandImage(brand: PickerBrand, ink: string, dark: boolean, useCustom: boolean): string;

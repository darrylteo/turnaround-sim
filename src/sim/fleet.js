/* Vehicle types: what each piece of GSE looks like and how big it is. Sizes are the fitted models' (metres:
   length, width, height). The model names map to files in models/ (credits in README). */

export const TYPES = {
  CAT:    { label: 'Catering truck',          model: 'catering', L: 8.5, W: 2.56, H: 3.19, color: '#3987e5' },
  FUEL:   { label: 'Fuel dispenser',          model: 'fuel',     L: 7.2, W: 2.05, H: 2.53, color: '#d95926' },
  LDCL:   { label: 'Cargo loader',            model: 'loader',   L: 8.0, W: 2.56, H: 4.07, color: '#c98500' },
  CB:     { label: 'Belt loader',             model: 'belt',     L: 7.5, W: 1.79, H: 1.99, color: '#d55181' },
  ULD:    { label: 'Container train',         model: 'tractor',  L: 3.6, W: 1.88, H: 1.59, color: '#9085e9', dollies: 2 },
  BULK:   { label: 'Bulk baggage train',      model: 'tractor',  L: 3.6, W: 1.88, H: 1.59, color: '#7f6bd6', dollies: 2 },
  LV:     { label: 'Toilet service truck',    model: 'water',    L: 6.5, W: 1.8,  H: 2.59, color: '#8a6d3b' },
  WV:     { label: 'Potable water truck',     model: 'water',    L: 6.5, W: 1.8,  H: 2.59, color: '#199e70' },
  GPU:    { label: 'Ground power unit',       model: 'gpu',      L: 3.4, W: 2.56, H: 1.75, color: '#6c7a89' },
  AC:     { label: 'Air conditioning unit',   model: 'gpu',      L: 3.4, W: 2.56, H: 1.75, color: '#3aa7b8' },
  TOW:    { label: 'Pushback tractor',        model: 'tractor',  L: 5.0, W: 2.6,  H: 2.2,  color: '#e0e0e0', scale: 1.4 },
  PLAYER: { label: 'Your baggage tractor',    model: 'tractor',  L: 3.6, W: 1.88, H: 1.59, color: '#ffd60a' },
};

export const DOLLY = { model: 'dolly', L: 3.4, W: 1.7, H: 2.3, gap: 0.6 };

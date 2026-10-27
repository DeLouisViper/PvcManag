/**
 * Calculation engine types.
 * ALL lengths inside the engine are INTEGER MILLIMETRES so that no floating point
 * error or intermediate rounding can ever change a result (12.5 m = 12500 mm).
 */

export type InstallationType = 'piezometer' | 'standpipe' | 'permeability' | 'seismic'

export const INSTALLATION_TYPES: InstallationType[] = ['piezometer', 'standpipe', 'permeability', 'seismic']

export interface TypeConfig {
  type: InstallationType
  /** inventory key of the PVC pipe material used by this type (material id in the app) */
  pipeKey: string
  /** inventory key of the screen material, or null when this type has no screen material (Seismic) */
  screenKey: string | null
  /** inventory key of the cap material */
  capKey: string
  projectionMm: number
  defaultScreenMm: number
}

export interface EngineConfig {
  /** standard length of one new PVC pipe (default 4000 mm) */
  stockLengthMm: number
  /** effective cutting allowance per saw cut (0 when disabled by Admin) */
  cuttingAllowanceMm: number
  /** a remainder shorter than this is scrap, not a reusable offcut (0 = keep everything) */
  minOffcutMm: number
  /** whether several PVC segments may be joined with couplings to build one installation */
  allowJoints: boolean
  types: Record<InstallationType, TypeConfig>
}

export interface OffcutInput {
  id: string
  lengthMm: number
}

export interface InventoryInput {
  /** number of full standard-length pipes, by pipe key */
  fullPipes: Record<string, number>
  /** individual reusable offcuts, by pipe key */
  offcuts: Record<string, OffcutInput[]>
  /** available screen length in mm, by screen key */
  screensMm: Record<string, number>
  /** available caps (pieces), by cap key */
  caps: Record<string, number>
}

export interface LocationInput {
  type: InstallationType
  code: string
  /** metres, as typed by the user (string) or number */
  depthM: string | number
  /** metres; null/undefined/'' => use the configured default */
  screenM?: string | number | null
}

export type IssueField = 'code' | 'depth' | 'screen' | 'general'

export interface ValidationIssue {
  rowIndex: number | null
  field: IssueField
  /** translation key suffix, see i18n "err.*" */
  code:
    | 'CODE_REQUIRED'
    | 'CODE_DUPLICATE'
    | 'DEPTH_REQUIRED'
    | 'DEPTH_NOT_POSITIVE'
    | 'DEPTH_PRECISION'
    | 'SCREEN_NEGATIVE'
    | 'SCREEN_PRECISION'
    | 'SCREEN_TOO_LONG'
    | 'SCREEN_NOT_APPLICABLE'
    | 'JOINT_REQUIRED'
    | 'NO_LOCATIONS'
    | 'CONFIG_INVALID'
  params?: Record<string, string | number>
}

export interface LocationResult {
  index: number
  type: InstallationType
  code: string
  depthMm: number
  projectionMm: number
  screenMm: number
  /** depth + projection */
  totalMm: number
  /** total - screen */
  pvcMm: number
  topCaps: 1
  bottomCaps: 1
  pipeKey: string
  screenKey: string | null
  capKey: string
  /** lengths (mm) of the PVC segments that make up this location, in plan order */
  segmentsMm: number[]
}

export type PlanSource = 'stock' | 'offcut' | 'generated'

export interface PlanStep {
  /** global 1-based step number, ordered so that a 'generated' source always comes after the step that created it */
  step: number
  pipeKey: string
  locationIndex: number
  source: PlanSource
  /** id of the existing offcut (source = 'offcut') */
  offcutId: string | null
  /** reference of a leftover generated earlier in the same plan (source = 'generated') */
  sourceRef: string | null
  sourceLengthMm: number
  cutMm: number
  /** reusable remainder kept as a new offcut */
  leftoverMm: number
  /** length lost to the saw cut (cutting allowance) */
  kerfMm: number
  /** remainder below the minimum reusable length, discarded */
  scrapMm: number
  /** reference of the leftover created by this step (when leftoverMm > 0) */
  leftoverRef: string | null
}

export interface GeneratedOffcut {
  ref: string
  lengthMm: number
}

export interface PipePlan {
  pipeKey: string
  requiredMm: number
  steps: PlanStep[]
  /** number of new full pipes taken from stock */
  newPipes: number
  rawNewMm: number
  offcutsConsumed: OffcutInput[]
  offcutsConsumedMm: number
  /** reusable offcuts that will exist after the job (not consumed later in the same plan) */
  generated: GeneratedOffcut[]
  generatedMm: number
  scrapMm: number
  kerfMm: number
  /** generated + scrap + kerf  =  raw material that is not part of the installed pipe */
  unusedMm: number
  /** number of couplings needed (segments - locations) */
  joints: number
}

export type StockBucket = 'full' | 'screen' | 'cap'

export interface StockLine {
  key: string
  bucket: StockBucket
  /** pcs for full/cap, mm for screen */
  unit: 'pcs' | 'mm'
  required: number
  available: number
  after: number
  missing: number
}

export interface OffcutLine {
  pipeKey: string
  beforeCount: number
  beforeMm: number
  consumedCount: number
  consumedMm: number
  generatedCount: number
  generatedMm: number
  afterCount: number
  afterMm: number
}

export interface TypeSummary {
  type: InstallationType
  locations: number
  depthMm: number
  totalMm: number
  pvcMm: number
  screenMm: number
  topCaps: number
  bottomCaps: number
}

export interface CapSummary {
  capKey: string
  top: number
  bottom: number
  total: number
}

export interface CalculationResult {
  ok: boolean
  issues: ValidationIssue[]
  locations: LocationResult[]
  byType: TypeSummary[]
  pipePlans: PipePlan[]
  caps: CapSummary[]
  stock: StockLine[]
  offcutLines: OffcutLine[]
  shortages: StockLine[]
  /** flat list of all plan steps (global numbering) */
  steps: PlanStep[]
  totalInstalledMm: number
  /** true when ok && no shortages */
  canSave: boolean
}

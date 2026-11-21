export interface TurnPreparation {
  readonly situation: readonly string[];
  readonly lateText: (text: string) => string;
}

export const unpreparedTurn: TurnPreparation = {
  situation: [],
  lateText: (text) => text,
};

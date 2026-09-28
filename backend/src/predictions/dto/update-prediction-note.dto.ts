import { IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { sanitizePlainText } from '../../common/text-sanitizer.util';

export const PREDICTION_NOTE_MAX_LENGTH = 1000;

export class UpdatePredictionNoteDto {
  @ApiProperty({
    description: 'Personal note for the prediction',
    example: 'I think this outcome is likely based on recent trends',
    maxLength: PREDICTION_NOTE_MAX_LENGTH,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? sanitizePlainText(value) : value,
  )
  @IsString()
  @MaxLength(PREDICTION_NOTE_MAX_LENGTH, {
    message: `note must be shorter than or equal to ${PREDICTION_NOTE_MAX_LENGTH} characters`,
  })
  note: string;
}

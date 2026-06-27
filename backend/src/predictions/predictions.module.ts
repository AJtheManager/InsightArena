import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Prediction } from './entities/prediction.entity';
import { PredictionsService } from './predictions.service';
import { PredictionsController } from './predictions.controller';
import { UsersModule } from '../users/users.module';
import { MarketsModule } from '../markets/markets.module';
import { SorobanModule } from '../soroban/soroban.module';
import { CommonModule } from '../common/common.module';
import { User } from '../users/entities/user.entity';
import { Market } from '../markets/entities/market.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Prediction, User, Market]),
    UsersModule,
    MarketsModule,
    SorobanModule,
    CommonModule,
  ],
  controllers: [PredictionsController],
  providers: [PredictionsService],
  exports: [PredictionsService],
})
export class PredictionsModule {}

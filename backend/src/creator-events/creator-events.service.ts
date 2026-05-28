import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ContractService,
  ContractEvent,
  ContractConfig,
  ContractParticipant,
  ContractMatch,
} from '../contract/contract.service';
import {
  ListParticipantsQueryDto,
  ParticipantSortBy,
  SortOrder as ParticipantSortOrder,
} from './dto/list-participants-query.dto';
import {
  ListMatchesQueryDto,
  MatchStatus,
  MatchSortBy,
  SortOrder,
} from './dto/list-matches-query.dto';
import {
  EventByCodeResponseDto,
  MatchPreviewDto,
} from './dto/event-by-code-response.dto';
import { UserScoreResponseDto } from './dto/user-score-response.dto';

export interface EnrichedEvent extends ContractEvent {
  matchCount: number;
  matchPreview: Array<{ matchId: string; homeTeam: string; awayTeam: string }>;
  winnerCount: number;
  creatorVerified: boolean;
}

export interface ParticipantWithStats {
  address: string;
  joinedAt: number;
  totalPredictions: number;
  correctPredictions: number;
  accuracyPct: number;
  rank: number;
}

export interface PaginatedParticipants {
  data: ParticipantWithStats[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class CreatorEventsService {
  private readonly logger = new Logger(CreatorEventsService.name);

  constructor(private readonly contractService: ContractService) {}

  async getEventById(id: string): Promise<EnrichedEvent> {
    const event = await this.contractService.getEvent(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    const [matches, winners, creatorVerified] = await Promise.all([
      this.contractService.getEventMatches(id),
      this.contractService.getEventWinners(id),
      this.contractService.isVerified(event.creator),
    ]);

    return {
      ...event,
      matchCount: matches.length,
      matchPreview: matches.slice(0, 5).map((m) => ({
        matchId: m.matchId,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
      })),
      winnerCount: winners.length,
      creatorVerified,
    };
  }

  async getParticipants(
    eventId: string,
    query: ListParticipantsQueryDto,
  ): Promise<PaginatedParticipants> {
    const raw: ContractParticipant[] =
      await this.contractService.getEventParticipants(eventId);

    const withStats: ParticipantWithStats[] = raw.map((p, i) => {
      const correct =
        typeof (p as ContractParticipant & { correctPredictions?: number })
          .correctPredictions === 'number'
          ? (p as ContractParticipant & { correctPredictions: number })
              .correctPredictions
          : 0;
      const accuracy =
        p.predictionCount > 0
          ? Math.round((correct / p.predictionCount) * 100)
          : 0;
      return {
        address: p.address,
        joinedAt: p.joinedAt,
        totalPredictions: p.predictionCount,
        correctPredictions: correct,
        accuracyPct: accuracy,
        rank: i + 1,
      };
    });

    const sorted = this.sortParticipants(
      withStats,
      query.sortBy,
      query.sortOrder,
    );
    sorted.forEach((p, i) => {
      p.rank = i + 1;
    });

    const total = sorted.length;
    const start = (query.page - 1) * query.limit;
    const data = sorted.slice(start, start + query.limit);

    return {
      data,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getContractConfig(): Promise<ContractConfig> {
    const config = await this.contractService.getConfig();

    if (!config) {
      this.logger.warn(
        'getContractConfig: contract returned null, returning defaults',
      );
      return {
        admin: '',
        aiAgent: '',
        treasury: '',
        celoToken: '',
        creationFee: '0',
        paused: false,
      };
    }

    return config;
  }

  async getEventMatches(
    eventId: string,
    query: ListMatchesQueryDto,
  ): Promise<
    Array<ContractMatch & { predictionCount: number; userPrediction?: string }>
  > {
    const event = await this.contractService.getEvent(eventId);
    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    let matches = await this.contractService.getEventMatches(eventId);

    if (query.status !== MatchStatus.All) {
      matches = matches.filter((m) => {
        if (query.status === MatchStatus.Pending) {
          return !m.resolved;
        }
        if (query.status === MatchStatus.Completed) {
          return m.resolved;
        }
        return true;
      });
    }

    matches = this.sortMatches(matches, query.sortBy, query.sortOrder);

    return matches.map((m) => ({
      ...m,
      predictionCount: 0,
    }));
  }

  async getEventByInviteCode(code: string): Promise<EventByCodeResponseDto> {
    const event = await this.contractService.getEventByCode(code);

    if (!event) {
      throw new NotFoundException(`Event with invite code ${code} not found`);
    }

    const [matches] = await Promise.all([
      this.contractService.getEventMatches(event.eventId),
      this.contractService.getEventWinners(event.eventId),
    ]);

    let status: 'active' | 'full' | 'cancelled' = 'active';
    if (!event.isActive) {
      status = 'cancelled';
    } else if (event.participantCount >= event.maxParticipants) {
      status = 'full';
    }

    const matchPreview: MatchPreviewDto[] = matches.slice(0, 5).map((m) => ({
      matchId: m.matchId,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      startTime: m.startTime,
    }));

    return {
      eventId: event.eventId,
      title: event.title,
      description: event.description,
      creator: event.creator,
      participantCount: event.participantCount,
      maxParticipants: event.maxParticipants,
      matchCount: matches.length,
      status,
      matchPreview,
      startTime: event.startTime,
      endTime: event.endTime,
    };
  }

  async getUserScore(
    eventId: string,
    address: string,
  ): Promise<UserScoreResponseDto> {
    const event = await this.contractService.getEvent(eventId);
    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    const [matches, userPredictions, participants] = await Promise.all([
      this.contractService.getEventMatches(eventId),
      this.contractService.getUserPredictions(address, eventId),
      this.contractService.getEventParticipants(eventId),
    ]);

    const userParticipant = participants.find((p) => p.address === address);
    const rank = userParticipant
      ? participants.findIndex((p) => p.address === address) + 1
      : participants.length + 1;

    let correctPredictions = 0;
    let incorrectPredictions = 0;
    let pendingPredictions = 0;

    for (const prediction of userPredictions) {
      const match = matches.find((m) => m.matchId === prediction.matchId);
      if (!match) continue;

      if (!match.resolved) {
        pendingPredictions++;
      } else if (match.outcome === prediction.chosenOutcome) {
        correctPredictions++;
      } else {
        incorrectPredictions++;
      }
    }

    const totalPredictions = userPredictions.length;
    const resolvedPredictions = correctPredictions + incorrectPredictions;
    const accuracyPercentage =
      resolvedPredictions > 0
        ? Math.round((correctPredictions / resolvedPredictions) * 100)
        : 0;

    const isWinner =
      totalPredictions > 0 &&
      incorrectPredictions === 0 &&
      pendingPredictions === 0;

    return {
      address,
      totalMatches: matches.length,
      totalPredictions,
      correctPredictions,
      incorrectPredictions,
      pendingPredictions,
      accuracyPercentage,
      rank,
      isWinner,
    };
  }

  private sortMatches(
    matches: ContractMatch[],
    sortBy: MatchSortBy,
    sortOrder: SortOrder,
  ): ContractMatch[] {
    const dir = sortOrder === SortOrder.Asc ? 1 : -1;

    return [...matches].sort((a, b) => {
      switch (sortBy) {
        case MatchSortBy.MatchTime:
          return (a.startTime - b.startTime) * dir;
        case MatchSortBy.CreatedAt:
          return (a.startTime - b.startTime) * dir;
        default:
          return 0;
      }
    });
  }

  private sortParticipants(
    participants: ParticipantWithStats[],
    sortBy: ParticipantSortBy,
    sortOrder: ParticipantSortOrder,
  ): ParticipantWithStats[] {
    const dir = sortOrder === ParticipantSortOrder.Asc ? 1 : -1;

    return [...participants].sort((a, b) => {
      switch (sortBy) {
        case ParticipantSortBy.JoinedAt:
          return (a.joinedAt - b.joinedAt) * dir;
        case ParticipantSortBy.Score:
          return (a.accuracyPct - b.accuracyPct) * dir;
        case ParticipantSortBy.Address:
          return a.address.localeCompare(b.address) * dir;
        default:
          return 0;
      }
    });
  }
}
// Copyright Abridged, Inc. 2023. All Rights Reserved.
// Node module: @collabland/example-token-price
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {debugFactory, getFetch, handleFetchResponse} from '@collabland/common';
import {
  APIChatInputApplicationCommandInteraction,
  APIInteractionResponse,
  ApplicationCommandOptionType,
  ApplicationCommandSpec,
  ApplicationCommandType,
  BaseDiscordActionController,
  buildSimpleResponse,
  DiscordActionMetadata,
  DiscordActionRequest,
  DiscordActionResponse,
  DiscordInteractionPattern,
  getCommandOptionValue,
  InteractionType,
  MessageFlags,
  RESTPatchAPIWebhookWithTokenMessageJSONBody,
} from '@collabland/discord';
import {MiniAppManifest} from '@collabland/models';
import {asLifeCycleObserver, BindingScope, injectable} from '@loopback/core';
import {api} from '@loopback/rest';
import {
  ActionRowBuilder,
  APIApplicationCommandAutocompleteInteraction,
  APIApplicationCommandAutocompleteResponse,
  APIInteraction,
  APIMessageComponentInteraction,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionResponseType,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import {URLSearchParams} from 'url';

const debug = debugFactory('collabland:token-price');

/**
 * TokenPriceController is a LoopBack REST API controller that exposes endpoints
 * to support Collab.Land actions for Discord interactions.
 */
@injectable(
  {
    scope: BindingScope.SINGLETON,
  },
  asLifeCycleObserver,
)
@api({basePath: '/token-price'}) // Set the base path to `/token-price`
export class TokenPriceController extends BaseDiscordActionController<APIInteraction> {
  private tokens: TokenInfo[];
  private collabToken: TokenInfo;

  async init() {
    this.tokens = await getTokens();
    this.collabToken = this.tokens.find(t => t.id === 'collab-land')!;
  }

  /**
   * Expose metadata for the action. The return value is used by Collab.Land `/test-flight` command
   * or marketplace to list this action as a miniapp.
   * @returns
   */
  async getMetadata(): Promise<DiscordActionMetadata> {
    const metadata: DiscordActionMetadata = {
      /**
       * Miniapp manifest
       */
      manifest: new MiniAppManifest({
        appId: 'token-price',
        developer: 'collab.land',
        name: 'TokenPrice',
        platforms: ['discord'],
        shortName: 'token-price',
        version: {name: '0.0.1'},
        website: 'https://collab.land',
        description: 'Getting token price',
      }),
      /**
       * Supported Discord interactions. They allow Collab.Land to route Discord
       * interactions based on the type and name/custom-id.
       */
      supportedInteractions: this.getSupportedInteractions(),
      /**
       * Supported Discord application commands. They will be registered to a
       * Discord guild upon installation.
       */
      applicationCommands: this.getApplicationCommands(),
    };
    return metadata;
  }

  /**
   * Handle the Discord slash commands
   * @param request - Discord interaction with Collab.Land action context
   * @returns - Discord interaction response
   */
  protected async handleApplicationCommand(
    request: DiscordActionRequest<APIChatInputApplicationCommandInteraction>,
  ): Promise<DiscordActionResponse> {
    switch (request.data.name) {
      case 'token-price': {
        /**
         * Get the value of `symbol` argument for `/token-price`
         */
        const symbol = getCommandOptionValue(request, 'symbol') ?? '';

        const token = this.tokens.find(t =>
          [
            t.id.toLowerCase(),
            t.name.toLowerCase(),
            t.symbol.toLowerCase(),
          ].includes(symbol.toLowerCase()),
        );

        if (token == null) {
          return buildSimpleResponse(`Unknown token ${symbol}`);
        }

        const response: APIInteractionResponse = await this.getQuoteMessage(
          request,
          token.id,
        );

        // Return the 1st response to Discord
        return response;
      }
      default: {
        return buildSimpleResponse(
          `Slash command ${request.data.name} is not implemented.`,
        );
      }
    }
  }

  private async getQuoteMessage(
    request: DiscordActionRequest<APIInteraction>,
    id: string,
  ) {
    const quote = await getTokenQuote(id);
    const ticker = quote.tickers[0];

    const appId = request.application_id;
    const response: APIInteractionResponse = {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        // content: `Token price for ${quote.symbol}`,
        embeds: [
          new EmbedBuilder()
            .setTitle(`$${quote.symbol.toUpperCase()} (${quote.name})`)
            .setColor('#f5c248')
            .setAuthor({
              name: 'Collab.Land',
              url: 'https://collab.land',
              iconURL: `https://cdn.discordapp.com/app-icons/${appId}/8a814f663844a69d22344dc8f4983de6.png`,
            })
            .setDescription(
              `${quote.asset_platform_id} [${quote.contract_address}](${quote.links.blockchain_site[0]})
  Market cap rank: ${quote.market_cap_rank}            
              
  Price: $${ticker.converted_last.usd}
  Volume: $${ticker.converted_volume.usd}
  Timestamp: ${ticker.timestamp}
  Last traded at: ${ticker.last_traded_at}
  `,
            )
            .setThumbnail(quote.image.small)
            .setFooter({text: 'Refreshed at: ' + new Date().toISOString()})
            .toJSON(),
        ],
        components: [
          new ActionRowBuilder<MessageActionRowComponentBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setLabel(`Refresh`)
                .setStyle(ButtonStyle.Primary)
                // Set the custom id to start with `token-price:`
                .setCustomId(`token-price:refresh-button:${id}`),
              new ButtonBuilder()
                .setLabel(`Chart`)
                .setStyle(ButtonStyle.Link)
                .setURL(`https://www.coingecko.com/en/coins/${quote.id}`),
            )
            .toJSON(),
        ],
        flags: MessageFlags.Ephemeral,
      },
    };
    return response;
  }

  /**
   * Handle the Discord message components including buttons
   * @param interaction - Discord interaction with Collab.Land action context
   * @returns - Discord interaction response
   */
  protected async handleMessageComponent(
    request: DiscordActionRequest<APIMessageComponentInteraction>,
  ): Promise<DiscordActionResponse> {
    if (request.data.custom_id.startsWith('token-price:refresh-button:')) {
      const id = request.data.custom_id.split(':')[2];
      this.refresh(request, id).catch(err => {
        console.error(
          'Fail to send followup message to interaction %s: %O',
          request.id,
          err,
        );
      });
    }

    // Instruct Discord that we'll edit the original message later on
    return {
      type: InteractionResponseType.DeferredMessageUpdate,
    };
  }

  /**
   * Run a refresh by updating the original message content
   * @param request
   */
  private async refresh(
    request: DiscordActionRequest<APIMessageComponentInteraction>,
    id: string,
  ) {
    const message = await this.getQuoteMessage(request, id);
    const updated: RESTPatchAPIWebhookWithTokenMessageJSONBody = message.data;
    await this.editMessage(request, updated, request.message.id);
  }

  protected async handleApplicationCommandAutoComplete(
    interaction: DiscordActionRequest<APIApplicationCommandAutocompleteInteraction>,
  ): Promise<APIApplicationCommandAutocompleteResponse | undefined> {
    debug('Autocomplete request: %O', interaction);
    const option = interaction.data.options.find(o => {
      return (
        o.name === 'symbol' &&
        o.type === ApplicationCommandOptionType.String &&
        o.focused
      );
    });
    if (option?.type === ApplicationCommandOptionType.String) {
      const prefix = option.value.toLowerCase();
      let choices = this.tokens
        .filter(c => {
          if (c.id === 'collab-land') {
            return false;
          }
          return (
            // c.id.toLowerCase().startsWith(prefix) ||
            c.symbol.toLowerCase().startsWith(prefix)
            // c.name.toLowerCase().startsWith(prefix)
          );
        })
        .map(c => ({name: `${c.symbol}: ${c.name}`, value: c.id}))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);

      if (
        'collab.land'.startsWith(prefix) ||
        'collab-land'.startsWith(prefix)
      ) {
        choices = [
          {
            name: `${this.collabToken.symbol} : ${this.collabToken.name}`,
            value: this.collabToken.id,
          },
          ...choices,
        ];
      }

      debug('Matching tokens for %s: %O', prefix, choices);

      const res: APIApplicationCommandAutocompleteResponse = {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: {
          choices,
        },
      };
      debug('Autocomplete response: %O', res);
      return res;
    }
  }

  /**
   * Build a list of supported Discord interactions. The return value is used as filter so that
   * Collab.Land can route the corresponding interactions to this action.
   * @returns
   */
  private getSupportedInteractions(): DiscordInteractionPattern[] {
    return [
      {
        // Handle `/token-price` slash command
        type: InteractionType.ApplicationCommand,
        names: ['token-price'],
      },
      {
        // Handle `/token-price` slash command autocomplete
        type: InteractionType.ApplicationCommandAutocomplete,
        names: ['token-price'],
      },
      {
        // Handle message components such as buttons
        type: InteractionType.MessageComponent,
        // Use a namespace to catch all buttons with custom id starting with `token-price:`
        ids: ['token-price:*'],
      },
    ];
  }

  /**
   * Build a list of Discord application commands. It's possible to use tools
   * like https://autocode.com/tools/discord/command-builder/.
   * @returns
   */
  private getApplicationCommands(): ApplicationCommandSpec[] {
    const commands: ApplicationCommandSpec[] = [
      // `/token-price <symbol>` slash command
      {
        metadata: {
          name: 'TokenPrice',
          shortName: 'token-price',
          supportedEnvs: ['dev', 'qa', 'staging'],
        },
        name: 'token-price',
        type: ApplicationCommandType.ChatInput,
        description: '/token-price',
        options: [
          {
            name: 'symbol',
            description: 'Token symbol',
            type: ApplicationCommandOptionType.String,
            required: true,
            autocomplete: true,
          },
        ],
      },
    ];
    return commands;
  }
}

export type TokenInfo = {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string>;
};

async function getTokens() {
  const url =
    'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
  const fetch = getFetch();
  const res = await fetch(url);
  const data = await handleFetchResponse<TokenInfo[]>(res);
  return data;
}

export type TokenQuoteOptions = {
  localization?: boolean;
  market_data?: boolean;
  community_data?: boolean;
  developer_data?: boolean;
  sparkline?: boolean;
};

export type TokenQuote = {
  id: string;
  symbol: string;
  name: string;
  asset_platform_id: string;
  platforms: Record<string, string>;
  detail_platforms: Record<
    string,
    {
      decimal_place: number;
      contract_address: string;
    }
  >;
  block_time_in_minutes: number;
  hashing_algorithm: string | null;
  categories: string[];
  public_notice: string | null;
  additional_notices: [];
  description: {
    en: string;
  };
  links: {
    homepage: string[];
    blockchain_site: string[];
    official_forum_url: string[];
    chat_url: string[];
    announcement_url: string[];
    twitter_screen_name: string;
    facebook_username: string;
    bitcointalk_thread_identifier: string | null;
    telegram_channel_identifier: string;
    subreddit_url: string | null;
    repos_url: {
      github: string[];
      bitbucket: string[];
    };
  };
  image: {
    thumb: string;
    small: string;
    large: string;
  };
  country_origin: string;
  genesis_date: string | null;
  contract_address: string;
  sentiment_votes_up_percentage: number;
  sentiment_votes_down_percentage: number;
  market_cap_rank: number;
  coingecko_rank: null;
  coingecko_score: number;
  developer_score: number;
  community_score: number;
  liquidity_score: number;
  public_interest_score: number;
  public_interest_stats: {
    alexa_rank: string | null;
    bing_matches: string | null;
  };
  status_updates: string[];
  last_updated: string;
  tickers: {
    base: string;
    target: string;
    market: {
      name: string;
      identifier: string;
      has_trading_incentive: boolean;
    };
    last: number;
    volume: number;
    converted_last: {
      btc: number;
      eth: number;
      usd: number;
    };
    converted_volume: {
      btc: number;
      eth: number;
      usd: number;
    };
    trust_score: string;
    bid_ask_spread_percentage: number;
    timestamp: string;
    last_traded_at: string;
    last_fetch_at: string;
    is_anomaly: false;
    is_stale: false;
    trade_url: string;
    token_info_url: string | null;
    coin_id: string;
    target_coin_id: string;
  }[];
};

async function getTokenQuote(id: string, options: TokenQuoteOptions = {}) {
  const query: Record<keyof TokenQuoteOptions, string> = {
    localization: 'false',
    market_data: 'false',
    community_data: 'false',
    developer_data: 'false',
    sparkline: 'false',
  };
  let p: keyof TokenQuoteOptions;
  for (p in options) {
    const flag = options[p];
    if (flag != null) {
      query[p] = flag.toString();
    }
  }
  const params = new URLSearchParams(query);
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
    id,
  )}?${params}`;
  const fetch = getFetch();
  const res = await fetch(url);
  const data = await handleFetchResponse<TokenQuote>(res);
  return data;
}

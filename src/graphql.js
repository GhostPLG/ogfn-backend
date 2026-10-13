import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLScalarType,
  Kind,
  GraphQLError
} from 'graphql';

const JsonScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize(value) { return value; },
  parseValue(value) { return value; },
  parseLiteral(node) {
    switch (node.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN: return node.value;
      case Kind.INT: return Number.parseInt(node.value, 10);
      case Kind.FLOAT: return Number.parseFloat(node.value);
      case Kind.OBJECT: return Object.fromEntries(node.fields.map((field) => [field.name.value, JsonScalar.parseLiteral(field.value)]));
      case Kind.LIST: return node.values.map((value) => JsonScalar.parseLiteral(value));
      case Kind.NULL: return null;
      default: return null;
    }
  }
});

const AccountType = new GraphQLObjectType({
  name: 'Account',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    displayName: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) }
  }
});

const OfferType = new GraphQLObjectType({
  name: 'ShopOffer',
  fields: {
    offerId: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    price: { type: new GraphQLNonNull(GraphQLInt) },
    category: { type: GraphQLString },
    storefront: { type: GraphQLString }
  }
});

const SessionType = new GraphQLObjectType({
  name: 'MatchSession',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    serverAddress: { type: new GraphQLNonNull(GraphQLString) },
    serverPort: { type: new GraphQLNonNull(GraphQLInt) },
    playlist: { type: GraphQLString },
    region: { type: GraphQLString },
    started: { type: GraphQLBoolean }
  }
});

const TicketType = new GraphQLObjectType({
  name: 'MatchTicket',
  fields: {
    ticketId: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    playlist: { type: GraphQLString },
    region: { type: GraphQLString },
    session: { type: SessionType },
    joinTicket: { type: GraphQLString },
    error: { type: JsonScalar }
  }
});

const PartyMemberType = new GraphQLObjectType({
  name: 'PartyMember',
  fields: {
    accountId: { type: new GraphQLNonNull(GraphQLString) },
    displayName: { type: new GraphQLNonNull(GraphQLString) },
    role: { type: new GraphQLNonNull(GraphQLString) },
    readiness: { type: GraphQLString }
  }
});

const PartyType = new GraphQLObjectType({
  name: 'LobbyParty',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    leader: { type: new GraphQLNonNull(GraphQLString) },
    revision: { type: GraphQLInt },
    members: { type: new GraphQLList(PartyMemberType) },
    config: { type: JsonScalar },
    matchmaking: { type: JsonScalar }
  }
});

function requireAccount(context) {
  if (!context.auth?.account) throw new GraphQLError('Authentication required.', { extensions: { code: 'UNAUTHENTICATED' } });
  return context.auth.account;
}

export function makeSchema(services) {
  const Query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      health: { type: GraphQLString, resolve: () => 'ok' },
      me: { type: AccountType, resolve: (_source, _args, context) => context.auth?.account ?? null },
      news: {
        type: JsonScalar,
        args: { mode: { type: GraphQLString } },
        resolve: (_source, args) => services.news.getNews(args.mode ?? 'br')
      },
      shopOffers: { type: new GraphQLList(OfferType), resolve: () => services.shop.getOffers() },
      athenaProfile: {
        type: JsonScalar,
        resolve: (_source, _args, context) => {
          const account = requireAccount(context);
          return services.profile.get(account.id, 'athena');
        }
      },
      matchmakingStatus: {
        type: TicketType,
        resolve: (_source, _args, context) => {
          const account = requireAccount(context);
          return services.matchmaker.getTicketByAccount(account.id);
        }
      },
      lobbyParty: {
        type: PartyType,
        resolve: (_source, _args, context) => {
          const account = requireAccount(context);
          return services.lobby.getForAccount(account.id);
        }
      }
    }
  });

  const Mutation = new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      joinMatchmakingQueue: {
        type: TicketType,
        args: { playlist: { type: GraphQLString }, region: { type: GraphQLString } },
        resolve: async (_source, args, context) => {
          const account = requireAccount(context);
          const ticket = await services.enqueueMatchmaking(account, args);
          return ticket;
        }
      },
      cancelMatchmakingQueue: {
        type: GraphQLBoolean,
        resolve: async (_source, _args, context) => {
          const account = requireAccount(context);
          const left = await services.matchmaker.leave(account.id);
          services.lobby.setMatchmaking(account.id, null);
          return left;
        }
      },
      createLobby: {
        type: PartyType,
        resolve: (_source, _args, context) => {
          const account = requireAccount(context);
          return services.lobby.getOrCreate(account);
        }
      },
      purchaseShopOffer: {
        type: JsonScalar,
        args: { offerId: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: async (_source, args, context) => {
          const account = requireAccount(context);
          return services.shop.buy(account.id, args.offerId);
        }
      }
    }
  });

  return new GraphQLSchema({ query: Query, mutation: Mutation });
}

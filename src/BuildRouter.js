/*
 * @author David Menger
 */
'use strict';

const requestNative = require('request-promise-native');
const Router = require('./Router');
const Ai = require('./Ai');
const expected = require('./resolvers/expected');

/**
 * Build bot from Wingbot configuration file or snapshot url
 *
 * @class BuildRouter
 */
class BuildRouter extends Router {

    /**
     * Create new router from configuration
     *
     * @constructor
     * @param {object} block
     * @param {string} [block.botId] - the ID of bot
     * @param {string} [block.snapshot] - snapshot stage of bot
     * @param {string} [block.token] - authorization token for bot
     * @param {object} [block.routes] - list of routes for direct bot build
     * @param {string} [block.url] - specify alternative configuration resource
     * @param {Blocks} blocksResource - custom code blocks resource
     * @example
     *
     * // usage under serverless environment
     *
     * const { Settings, BuildRouter, Blocks } = require('botnaut');
     * const { createHandler, createProcessor } = require('botnaut/serverlessAWS');
     * const dynamoDb = require('./lib/dynamodb');
     * const config = require('./config');
     *
     * const blocks = new Blocks();
     *
     * blocks.code('exampleBlock', function* (req, res) {
     *     yield res.run('responseBlockName');
     * });
     *
     * const bot = new BuildRouter({
     *     botId: 'b7a71c27-c295-4ab0-b64e-6835b50a0db0',
     *     stage: 'master'
     * }, blocks);
     *
     * const processor = createProcessor(bot, {
     *     appUrl: config.pageUrl,
     *     pageToken: config.facebook.pageToken,
     *     appSecret: config.facebook.appSecret,
     *     autoTyping: true,
     *     dynamo: {
     *         db: dynamoDb,
     *         tablePrefix: `${config.prefix}-`
     *     }
     * });
     *
     * const settings = new Settings(config.facebook.pageToken, log);
     *
     * if (config.isProduction) {
     *     settings.getStartedButton('/start');
     *     settings.whitelistDomain(config.pageUrl);
     * }
     *
     * module.exports.handleRequest = createHandler(processor, config.facebook.botToken);
     */
    constructor (block, blocksResource, context = {}, request = requestNative) {
        super();

        if (!block || typeof block !== 'object') {
            throw new Error('Params should be an object');
        }

        this._blocksResource = blocksResource;

        this._context = context;

        this._linksMap = new Map();

        this._loadBotUrl = null;

        this._loadBotAuthorization = null;

        this._botLoaded = null;

        this._request = request;

        if (typeof block.routes === 'object') {
            this._buildBot(block);
        } else if (typeof block.url === 'string') {
            this._loadBotUrl = block.url;
        } else if (typeof block.botId === 'string') {
            const snapshot = block.snapshot || 'production';
            this._loadBotUrl = `https://api.wingbot.ai/bots/${block.botId}/snapshots/${snapshot}`;
        } else {
            throw new Error('Not implemented yet');
        }

        this._loadBotAuthorization = block.token || null;
    }

    reduce (...args) {
        if (this._botLoaded === null) {
            this._botLoaded = this._loadBot();
        }
        return this._botLoaded
            .then(() => super.reduce(...args));
    }

    _loadBot () {
        const req = {
            url: this._loadBotUrl,
            json: true
        };

        if (this._loadBotAuthorization) {
            req.headers = {
                Authorization: this._loadBotAuthorization
            };
        }

        return this._request(req)
            .then((snapshot) => {
                if (!snapshot || !Array.isArray(snapshot.blocks)) {
                    throw new Error('Bad BOT definition API response');
                }
                const { blocks } = snapshot;

                this._context = { blocks };

                const rootBlock = blocks.find(block => block.isRoot);

                this._buildBot(rootBlock);
            });
    }

    _buildBot (block) {
        this._linksMap = this._createLinksMap(block);

        this._setExpectedFromResponderRoutes(block.routes);

        this._buildRoutes(block.routes);

        this._botLoaded = Promise.resolve();
    }

    _setExpectedFromResponderRoutes (routes) {
        const set = new Set();

        routes.forEach((route) => {
            if (!route.isResponder) {
                return;
            }

            // create the pseudopath ant set to set to corresponding route
            const referredRoutePath = this._linksMap.get(route.respondsToRouteId);

            if (!referredRoutePath) {
                return;
            }

            const path = `${referredRoutePath}_responder`
                .replace(/^\//, '');

            Object.assign(route, { path });

            // set expectedPath to referredRoute

            if (set.has(route.respondsToRouteId)) {
                return;
            }
            set.add(route.respondsToRouteId);

            const referredRoute = routes.find(r => r.id === route.respondsToRouteId);

            Object.assign(referredRoute, { expectedPath: path });
        });
    }

    _findEntryPointsInResolver (linksMap, resolver, route, context) {
        const includedBlock = context.blocks
            .find(b => b.staticBlockId === resolver.params.staticBlockId);

        if (!includedBlock) {
            return;
        }

        includedBlock.routes.forEach((blockRoute) => {
            if (!blockRoute.isEntryPoint || blockRoute.isRoot) {
                return;
            }

            linksMap.set(`${route.id}/${blockRoute.id}`, `${route.path}/${blockRoute.path}`);
        });
    }

    _createLinksMap (block) {
        const linksMap = new Map();

        block.routes
            .filter(route => !route.isFallback && !route.isResponder)
            .forEach(route => linksMap.set(route.id, route.path));

        block.routes.forEach((route) => {
            let resolver;
            for (resolver of route.resolvers) {
                if (resolver.type !== 'botbuild.include') {
                    continue;
                }
                this._findEntryPointsInResolver(linksMap, resolver, route, this._context);
            }
        });

        return linksMap;
    }

    _buildRouteHead (route) {
        const resolvers = [];

        if (route.isFallback) {
            // dont add path or AI
            return resolvers;
        }

        let aiResolver = null;

        if (route.aiTags && route.aiTags.length) {
            aiResolver = Ai.ai.match(route.aiTags);
        }

        if (aiResolver && route.isResponder) {
            resolvers.push(route.path, aiResolver);
        } else if (aiResolver) {
            resolvers.push([route.path, aiResolver]);
        } else {
            resolvers.push(route.path);
        }

        if (route.expectedPath) {
            resolvers.push(expected({ path: route.expectedPath }, { isLastIndex: false }));
        }

        return resolvers;
    }

    _buildRoutes (routes) {
        routes.forEach((route) => {
            const register = this.use(...[
                ...this._buildRouteHead(route),
                ...this.buildResolvers(route.resolvers)
            ]);
            this._attachExitPoints(register, route.resolvers);
        });
    }

    _attachExitPoints (register, routeResolvers) {
        routeResolvers.forEach((resolver) => {
            if (resolver.type !== 'botbuild.include') {
                return;
            }

            Object.keys(resolver.params.items)
                .forEach((exitName) => {
                    const { resolvers } = resolver.params.items[exitName];
                    register.onExit(exitName, this._buildExitPointResolver(resolvers));
                });
        });
    }

    _buildExitPointResolver (resolvers) {
        const builtResolvers = this.buildResolvers(resolvers);
        const reducers = this.createReducersArray(builtResolvers);
        return (data, req, res, postBack) => {
            const path = res.path;
            const action = req.action();
            return this.processReducers(reducers, req, res, postBack, path, action);
        };
    }

    buildResolvers (resolvers) {
        const lastIndex = resolvers.length - 1;

        return resolvers.map((resolver, i) => {
            const context = Object.assign({}, this._context, {
                isLastIndex: lastIndex === i,
                router: this,
                linksMap: this._linksMap
            });

            return this._resolverFactory(resolver, context);
        });
    }

    _resolverFactory (resolver, context) {
        const factoryFn = this._blocksResource.getResolverFactory(resolver.type);

        return factoryFn(resolver.params, context, this._blocksResource);
    }

}

/**
 *
 */
BuildRouter.fromData = function fromData (blocks, blocksResource) {
    const context = {
        blocks
    };

    const rootBlock = blocks.find(block => block.isRoot);

    return new BuildRouter(rootBlock, blocksResource, context);
};

module.exports = BuildRouter;

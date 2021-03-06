/*
 * @author David Menger
 */
'use strict';

function customCode (params, context, blocks) {
    const customFn = blocks.getCustomCodeFactory(params.codeBlockId);

    const { router } = context;

    const items = Object.keys(params.items)
        .reduce((obj, itemName) => {
            const item = params.items[itemName];
            const builtResolvers = router.buildResolvers(item.resolvers);
            const reducers = router.createReducersArray(builtResolvers);

            return Object.assign(obj, { [itemName]: reducers });
        }, {});

    return (req, res, postBack, path, action) => {

        Object.assign(res, {
            run (codeBlockName) {
                if (typeof items[codeBlockName] === 'undefined') {
                    throw new Error(`Code block '${codeBlockName}' does not exits`);
                }

                const reducers = items[codeBlockName];
                return router.processReducers(reducers, req, res, postBack, path, action);
            }
        });

        // assign to res
        return customFn(req, res, postBack);
    };
}

module.exports = customCode;

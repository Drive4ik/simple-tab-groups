
const MODULES = {
    browser,
};

/**
 * module descriptor format:
 * string  - 'module-name@someFunc'   (arguments are not supported)
 * array   - ['module-name', 'someFunc', 'arg1', 'arg2', {arg3: true}]
 * object  - { name: 'module-name', method: 'someFunc', args: ['arg1', 'arg2', {arg3: true}] }
 */
export default async function runModule(moduleDescriptor, ...extraArgs) {
    let moduleName;
    let moduleMethod;
    let moduleArgs;

    if (typeof moduleDescriptor === 'string') {
        moduleDescriptor = moduleDescriptor.split('@', 2);
    }

    if (Array.isArray(moduleDescriptor)) {
        [moduleName, moduleMethod, ...moduleArgs] = moduleDescriptor;
    } else {
        moduleName = moduleDescriptor.name;
        moduleMethod = moduleDescriptor.method;
        moduleArgs = moduleDescriptor.args;
    }

    const mod = await (MODULES[moduleName] ?? import(`./${moduleName}.js`));

    moduleMethod ||= 'default';
    moduleArgs ||= [];

    const methodParts = moduleMethod.split('.');
    const method = methodParts.reduce((obj, key) => obj?.[key], mod)
        ?? methodParts.reduce((obj, key) => obj?.[key], mod.default);

    return await method(...moduleArgs, ...extraArgs);
}

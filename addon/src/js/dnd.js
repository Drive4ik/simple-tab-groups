
/*
binding:
    name: Название директивы, без указания префикса v-.
    value: Значение, переданное в директиву. Например, для v-my-directive="1 + 1" значением будет 2.
    oldValue: Предыдущее переданное в директиву значение. Доступно только для хуков update и componentUpdated, и передаётся независимо от того, произошло ли в действительности его изменение.
    expression: Выражение-строка, переданное в директиву. Например, для v-my-directive="1 + 1" это будет "1 + 1".
    arg: Аргумент, переданный в директиву, в случае его наличия. Например, для v-my-directive:foo это будет "foo".
    modifiers: Объект, содержащий модификаторы, если они есть. Например, для v-my-directive.foo.bar, объектом модификаторов будет { foo: true, bar: true }.

*/

let dragData = null;

function bindAndUpdate(el, binding, vnode) {
    // console.log('bind', Array.from(arguments));

    // binding.value.group.$emit('aaa', 'group', binding.value.group);

    let handleBined = handle.bind(null, binding.arg, binding.modifiers, binding.value, vnode.context);

    el.draggable = true;

    // el.removeEventListener('dragstart', false);
    // el.removeEventListener('dragenter', false);
    // el.removeEventListener('dragover', false);
    // el.removeEventListener('dragleave', false);
    // el.removeEventListener('drop', false);
    // el.removeEventListener('dragend', false);

    el.addEventListener('dragstart', handleBined);
    el.addEventListener('dragenter', handleBined);
    el.addEventListener('dragover', handleBined);
    el.addEventListener('dragleave', handleBined);
    el.addEventListener('drop', handleBined);
    el.addEventListener('dragend', handleBined);

}

function handle(itemType, allowItemTypes, data, bus, event) {
    // let itemType = binding.arg,
    //     item = binding.value.item,
    //     itemIndex = binding.value.itemIndex;

    let item = data.item,
        itemIndex = data.itemIndex;

    // console.info(binding, vnode, event);

    if (event.type !== 'dragstart' && (!dragData || !allowItemTypes[itemType])) {
        // console.warn('RETURN', dragData, binding.modifiers, itemType)
        return;
    }

    switch (event.type) {
        case 'dragstart':
            // item.isMoving = true;

            bus.$emit('drag-moving', item);

            console.warn('START');
            event.stopPropagation();

            dragData = {data, itemType};

            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/html', 'tmp');

            // if (itemType !== 'group') {
            //     event.dataTransfer.setDragImage(event.target, event.target.clientWidth / 2, event.target.clientHeight / 2);
            // }


            break;
        case 'dragenter':
            event.preventDefault();
            event.stopPropagation();

            // item.isOver = true;
            break;
        case 'dragover':
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';

            return false;
            break;
        case 'dragleave':
            event.stopPropagation();

            // item.isOver = false;
            break;
        case 'drop':
            event.preventDefault();
            event.stopPropagation();

            // item.isOver = false;

            if (item !== dragData.item) {
                console.info('from:', dragData, 'to:', {data, itemType}, bus, event);

                // this.$emit('drag-move-' + this.dragData.itemType, this.dragData, {
                //     itemIndex,
                //     item,
                //     itemType,
                //     allowTypes,
                // });
            }

            return false;
            break;
        case 'dragend':
            event.stopPropagation();

            // this.removeAttribute('draggable');

            // dragData.item.isMoving = false;
            dragData = null;
            break;

    }
};



export default {
    bind: bindAndUpdate,
    update: bindAndUpdate,
    unbind(el, binding, vnode) {
        console.log('unbind', Array.from(arguments));
    },
};

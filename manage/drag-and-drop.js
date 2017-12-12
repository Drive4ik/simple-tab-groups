// Drag and drop utils

let DragAndDrop = new function() {
    let groups = {},
        draggedElement = null,
        $on = on.bind({}),
        _dragEnter = null,
        _dragLeave = null;

    // function getEls(options) {
    //     return document.querySelectorAll(options.selector);
    // }

    this.create = function(options) {
        groups[options.group] = options;

        // $on('mousedown mouseup', options.selector, );

        // let elements = Array.from(document.querySelectorAll(options.selector));

        document.querySelectorAll(options.selector).forEach(function(element) {
            element.dnd = options;
            element.addEventListener('dragstart', dragStart, false);
            element.addEventListener('dragenter', dragEnter, false);
            element.addEventListener('dragover', dragOver, false);
            element.addEventListener('dragleave', dragLeave, false);
            element.addEventListener('drop', drop, false);
            element.addEventListener('dragend', dragEnd, false);

            element.addEventListener('mousedown', onMouseDownUp, false);
            element.addEventListener('mouseup', onMouseDownUp, false);
        });
    };

    function onMouseDownUp(event) {
        let options = this.dnd;
        // console.log('onMouseDownUp', options, event);
        if (1 !== event.which) {
            return;
        }

        if (!event.target.matches || !event.target.matches(options.draggableElements)) {
            return;
        }

        // event.preventDefault();
        event.stopPropagation();

        if (event.type === 'mousedown') {
            this.draggable = true;
        } else if (event.type === 'mouseup') {
            this.removeAttribute('draggable');
        }
    }

    let prevOverElement = null,
        currentOptions = null;

    function dragStart(event) {
        let options = this.dnd;
        console.log(options.group.name + ' - dragStart', this);

        this.classList.add(options.startDragClass || 'moving');

        event.stopPropagation();

        currentOptions = options;

        draggedElement = this;

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/html', this.innerHTML);
        // event.dataTransfer.setData('text', '');

        options.onStart && options.onStart(event);
    }

    function dragEnter(event) {
        let options = this.dnd;

        if (!options) { // TMP
            return;
        }

        console.log(options.group.name + ' - dragEnter', currentOptions.group.put.includes(options.group.name));
        if (!currentOptions.group.put.includes(options.group.name)) {
            // return;
        }

        console.log(options.group.name + ' - dragEnter', this);

        // let groupNode = getParentFromChild(this, options);

        // remove over class from rev over element;
        // if (prevOverElement) {
        //     let prevGroupNode = getGroupNodeFromChild(prevOverElement);
        //     if (prevGroupNode && prevGroupNode !== groupNode) {
        //         prevGroupNode.classList.remove('over');
        //     }
        // }


        // _dragLeave && _dragLeave();
        // _dragLeave = null;

        // _dragEnter = () => this.classList.add('over');


        // if (groupNode) {
            // options._onEnterFunc = () => this.classList.add('over');
            this.classList.add('over');
            // setTimeout(() => groupNode.classList.add('over'), 10);
        // }
    }

    function dragLeave(event) {
        let options = this.dnd;

        if (!options) { // TMP
            return;
        }

        if (!currentOptions.group.put.includes(options.group.name)) {
            // return;
        }

        // if (!dragGroupNode) {
        //     return;
        // }
        console.log(options.group.name + ' - dragLeave', this);
        // prevOverElement = event.target;

        // let groupNode = getParentFromChild(event.target, options);

        // if (this) {
            // console.log('leave');
            this.classList.remove('over');
        // }

        // _dragLeave = () => this.classList.remove('over');

        // _dragEnter && _dragEnter();
        // _dragEnter = null;

        // if (options._onEnterFunc) {
        //     options._onEnterFunc();
        //     delete options._onEnterFunc;
        // }
    }

    function dragOver(event) {
        let options = this.dnd;

        if (!options) { // TMP
            return;
        }

        if (!currentOptions.group.put.includes(options.group.name)) {
            return;
        }

        // if (!dragGroupNode) {
        //     return;
        // }
        // console.log(group + ' - dragOver', this, event);
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        return false;
    }

    function drop(event) {
        let options = this.dnd;

        if (!currentOptions.group.put.includes(options.group.name)) {
            return;
        }

        console.log(options.group.name + ' - drop', this);
        // if (!dragGroupNode) {
        //     return;
        // }

        event.stopPropagation(); // stops the browser from redirecting.

        if (draggedElement != this) {
            // console.log(options.group + ' - drop', event);
            draggedElement.innerHTML = this.innerHTML;
            this.innerHTML = event.dataTransfer.getData('text/html');

            options.onDrop && options.onDrop(event);

            // TODO move group dataTransfer
        }

        return false;
    }

    function dragEnd(event) {
        let options = this.dnd;

        if (!currentOptions.group.put.includes(options.group.name)) {
            return;
        }

        console.log(options.group.name + ' - dragEnd', this);
        // if (!dragGroupNode) {
        //     return;
        // }

        // console.log(group + ' - dragEnd', event);
        prevOverElement = draggedElement = null;

        document.querySelectorAll(currentOptions.selector).forEach(function(element) {
            element.removeAttribute('draggable');
            element.classList.remove('over', 'moving');
        });

        document.querySelectorAll(options.selector).forEach(function(element) {
            element.removeAttribute('draggable');
            element.classList.remove('over', 'moving');
        });

        delete this.dnd;

        options.onEnd && options.onEnd(event);
    }








    function getParentFromChild(element, options) {
        return element.closest(options.selector);
    }



    // function getTabNodeFromChild(child) {
    //     if (child.nodeName !== '#text' && child.matches('[data-is-tab]')) {
    //         return child;
    //     }

    //     while (child.parentNode) {
    //         if (child.parentNode.matches && child.parentNode.matches('[data-is-tab]')) {
    //             return child.parentNode;
    //         }

    //         child = child.parentNode;
    //     }
    // }







};

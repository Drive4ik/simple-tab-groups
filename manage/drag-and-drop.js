// Drag and drop utils

let DragAndDrop = new function() {
    let groups = {},
        draggedElement = null,
        $on = on.bind({});

    function getElsFromGroup(group) {
        return document.querySelectorAll(groups[group].selector);
    }

    this.create = function(options) {
        groups[options.group] = options;

        // $on('mousedown mouseup', options.selector, );

        // let elements = Array.from(document.querySelectorAll(options.selector));

        getElsFromGroup(options.group).forEach(function(element) {
            element.addEventListener('dragstart', dragStart.bind(element, options), false);
            element.addEventListener('dragenter', dragEnter.bind(element, options), false);
            element.addEventListener('dragover', dragOver.bind(element, options), false);
            element.addEventListener('dragleave', dragLeave.bind(element, options), false);
            element.addEventListener('drop', drop.bind(element, options), false);
            element.addEventListener('dragend', dragEnd.bind(element, options), false);

            element.addEventListener('mousedown', onMouseDownUp.bind(element, options), false);
            element.addEventListener('mouseup', onMouseDownUp.bind(element, options), false);
        });
    };

    function onMouseDownUp(options, event) {
        // console.log('onMouseDownUp', options, event);
        if (1 !== event.which) {
            return;
        }

        // if (!event.target.matches || !event.target.matches(options.draggableElements)) {
        //     return;
        // }

        // event.preventDefault();
        event.stopPropagation();

        if (event.type === 'mousedown') {
            this.draggable = true;
        } else if (event.type === 'mouseup') {
            this.removeAttribute('draggable');
        }
    }

    let prevOverElement = null,
        currentGroup = null;

    function dragStart(options, event) {
        console.log(options.group + ' - dragStart', this);

        this.classList.add(options.startDragClass || 'moving');

        event.stopPropagation();

        currentGroup = options.group;

        draggedElement = this;

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/html', this.innerHTML);

        options.onStart && options.onStart(event);
    }

    function dragEnter(options, event) {
        if (currentGroup !== options.group) {
            return;
        }

        console.log(options.group + ' - dragEnter', this);

        let groupNode = getParentFromChild(this, options);

        // remove over class from rev over element;
        // if (prevOverElement) {
        //     let prevGroupNode = getGroupNodeFromChild(prevOverElement);
        //     if (prevGroupNode && prevGroupNode !== groupNode) {
        //         prevGroupNode.classList.remove('over');
        //     }
        // }



        if (groupNode) {
            options._onEnterFunc = () => groupNode.classList.add('over');
            // setTimeout(() => groupNode.classList.add('over'), 10);
        }
    }

    function dragLeave(options, event) {
        if (currentGroup !== options.group) {
            return;
        }

        // if (!dragGroupNode) {
        //     return;
        // }
        console.log(options.group + ' - dragLeave', this);
        // prevOverElement = event.target;

        // let groupNode = getParentFromChild(event.target, options);

        if (this) {
            // console.log('leave');
            this.classList.remove('over');
        }

        if (options._onEnterFunc) {
            options._onEnterFunc();
            delete options._onEnterFunc;
        }
    }

    function dragOver(options, event) {
        if (currentGroup !== options.group) {
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

    function drop(options, event) {
        if (currentGroup !== options.group) {
            return;
        }

        console.log(options.group + ' - drop', this);
        // if (!dragGroupNode) {
        //     return;
        // }

        event.stopPropagation(); // stops the browser from redirecting.

        if (draggedElement != this) {
            // console.log(options.group + ' - drop', event);
            draggedElement.innerHTML = this.innerHTML;
            this.innerHTML = event.dataTransfer.getData('text/html');

            // TODO move group dataTransfer
        }

        return false;
    }

    function dragEnd(options, event) {
        if (currentGroup !== options.group) {
            return;
        }

        console.log(options.group + ' - dragEnd', this);
        // if (!dragGroupNode) {
        //     return;
        // }

        // console.log(group + ' - dragEnd', event);
        prevOverElement = draggedElement = null;

        getElsFromGroup(options.group).forEach(function(element) {
            element.removeAttribute('draggable');
            element.classList.remove('over', 'moving');
        });
    }








    function getParentFromChild(element, options) {
        if (element.matches && element.matches(options.selector)) {
            return element;
        }

        while (element.parentNode) {
            if (element.parentNode.matches(options.selector)) {
                return element.parentNode;
            }

            element = element.parentNode;
        }
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

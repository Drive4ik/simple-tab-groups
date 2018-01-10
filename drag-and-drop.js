// Drag and drop utils

let DragAndDrop = new function() {
    'use strict';

    let allOptions = [],
        draggedNode = null,
        $on = on.bind({});

    const defOptions = {
        selector: 'div',
        group: null,
        classNameDraggedElement: 'drag-moving',
        classNameOverElement: 'drag-over',
    };

    function _getPreparedGroup(rawGroup) {
        let group = {
            name: Date.now(),
            put: [],
        };

        if ('string' === type(rawGroup)) {
            group.name = rawGroup;
        } else if ('object' === type(rawGroup)) {
            Object.assign(group, rawGroup);
        }

        return group;
    }

    this.create = function(rawOptions) {
        let options = Object.assign({}, defOptions, rawOptions),
            extendNode = {options};

        options.group = _getPreparedGroup(options.group);

        allOptions.push(options);

        $on('dragstart', options.selector, dragStart, extendNode, false);
        $on('dragenter', options.selector, dragEnter, extendNode, false);
        $on('dragover', options.selector, dragOver, extendNode, false);
        $on('dragleave', options.selector, dragLeave, extendNode, false);
        $on('drop', options.selector, drop, extendNode, false);
        $on('dragend', options.selector, dragEnd, extendNode, false);

        $on('mousedown mouseup', options.selector, onMouseDownUp, extendNode, false);
    };

    function onMouseDownUp(event) {
        if (1 !== event.which) {
            return;
        }

        if (event.target.matches && event.target.matches(this.options.draggableElements)) {
            if ('mousedown' === event.type) {
                this.draggable = true;
            } else if ('mouseup' === event.type) {
                this.removeAttribute('draggable');
            }
        }
    }

    let prevOverElement = null;

    function dragStart(event) {
        this.classList.add(this.options.classNameDraggedElement);

        event.stopPropagation();

        // remove events from childs when drag enter
        setPointerEvents(this.options);

        draggedNode = this;

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/html', this.innerHTML);

        draggedNode.options.onStart && draggedNode.options.onStart(event);
    }

    function dragEnter(event) {
        if (!draggedNode || this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        this.classList.add(this.options.classNameOverElement);
    }

    function dragLeave(event) {
        if (!draggedNode || this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        this.classList.remove(this.options.classNameOverElement);
    }

    function dragOver(event) {
        if (!draggedNode || this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        return false;
    }

    function drop(event) {
        if (!draggedNode || this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        if (draggedNode !== this) {
            // console.log(this.options.group.name + ' - drop', event);
            // draggedNode.innerHTML = this.innerHTML;
            // this.innerHTML = event.dataTransfer.getData('text/html');

            draggedNode.options.onDrop && draggedNode.options.onDrop(event, draggedNode, this, dataFromElement(draggedNode), dataFromElement(this));
        }

        return false;
    }

    function dragEnd(event) {
        if (!draggedNode || this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        removeClasses(draggedNode.options, this.options);

        setPointerEvents(this.options, false);

        this.removeAttribute('draggable');

        draggedNode.options.onEnd && draggedNode.options.onEnd(event);

        draggedNode = null;
    }

    function setPointerEvents(options, setEvents = true) {
        $$(options.selector).forEach(node => Array.from(node.children).forEach(child => child.style.pointerEvents = (setEvents ? 'none' : '')));

        allOptions.forEach(function(opt) {
            if (opt.group.name !== options.group.name && opt.group.put.includes(options.group.name)) {
                $$(opt.selector).forEach(function(node) {
                    Array.from(node.children).forEach(child => child.style.pointerEvents = (setEvents ? 'none' : ''));

                    node.querySelectorAll(`[data-draggable-group="${options.group.name}"]`).forEach(n => n.style.pointerEvents = (setEvents ? 'all' : ''));
                });
            }
        });
    }

    function removeClasses(firstOptions, secondOptions) {
        let classList = [firstOptions.classNameDraggedElement, firstOptions.classNameOverElement];

        if (!classList.includes(secondOptions.classNameDraggedElement)) {
            classList.push(secondOptions.classNameDraggedElement);
        }

        if (!classList.includes(secondOptions.classNameOverElement)) {
            classList.push(secondOptions.classNameOverElement);
        }

        $$('.' + classList.join(', .')).forEach(element => element.classList.remove.apply(element.classList, classList));
    }

};

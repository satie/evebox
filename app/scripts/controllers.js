/*
 * Copyright (c) 2014 Jason Ish
 * All rights reserved.
 */

/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

app.controller("RecordController", function ($scope, $routeParams, Util,
    ElasticSearch) {

    // Export some functions to $scope.
    $scope.Util = Util;

    ElasticSearch.searchEventById($routeParams.id)
        .success(function (response) {
            $scope.response = response;
            $scope.hits = response.hits;
        });

});

app.controller("ArchiveEventsByQueryModal", function ($scope, ElasticSearch,
    args) {

    $scope.title = args.title;
    $scope.archived = 0;
    $scope.total = undefined;

    modalScope = $scope;

    console.log(args.query);

    var searchThenArchive = function () {
        ElasticSearch.search(args.query)
            .success(function (response) {
                if ($scope.total == undefined) {
                    $scope.total = response.hits.total;
                }
                if (response.hits.hits.length > 0) {
                    ElasticSearch.bulkRemoveTag(response.hits.hits, "inbox")
                        .success(function (response) {
                            $scope.archived += response.items.length;
                            searchThenArchive();
                        });
                }
                else {
                    $scope.$close();
                }
            });
    };

    searchThenArchive();

});

/**
 * Controller for table of alerts grouped client side.
 */
app.controller("GroupedAlertController", function ($scope, Keyboard,
    ElasticSearch) {

    console.log("GroupedAlertController: id=" + $scope.$id);

    GroupedAlertController = $scope;

    $scope.activeRowIndex = 0;

    $scope.archiveSelected = function () {
        var groupsToArchive = _.filter($scope.grouped, function (group) {
            return group.__selected || false;
        });
        var eventsToArchive = _.flatten(groupsToArchive);
        ElasticSearch.bulkRemoveTag(eventsToArchive, "inbox")
            .success(function (response) {
                _.forEach(eventsToArchive, function (event) {
                    var removed = _.remove($scope.hits.hits, event);
                });
            })
            .error(function (error) {
                console.log("error archiving events...");
                console.log(error);
            })
            .finally(function () {
                $scope.rollUp();
            })
    };

    $scope.$on("$destroy", function () {
        console.log("GroupedAlertController: scope destroyed.");
        Keyboard.resetScope($scope);
    });

    Keyboard.scopeBind($scope, "e", function () {
        $scope.$apply(function () {
            $scope.archiveSelected();
        });
    });

    Keyboard.scopeBind($scope, "j", function () {
        $scope.$apply(function () {
            if ($scope.activeRowIndex < $scope.grouped.length - 1) {
                $scope.activeRowIndex++;
            }
        });
    });

    Keyboard.scopeBind($scope, "k", function () {
        $scope.$apply(function () {
            if ($scope.activeRowIndex > 0) {
                $scope.activeRowIndex--;
            }
        });
    });

    Keyboard.scopeBind(scope, "x", function () {
        $scope.$apply(function () {
            $scope.grouped[$scope.activeRowIndex].__selected = !$scope.grouped[$scope.activeRowIndex].__selected;
        });
    })
});

app.controller("AggregationController", function ($scope, $location, Keyboard,
    ElasticSearch, $modal) {

    var getActiveBucket = function () {
        return $scope.buckets[$scope.activeRowIndex];
    };

    $scope.openAggregation = function (bucket) {
        $location.search({"q": "alert.signature.raw:\"" + bucket.key + "\"",
            "aggregateBy": ""});
    };

    $scope.toggleSelected = function () {
        var bucket = getActiveBucket();
        bucket.__selected = !bucket.__selected;
    };

    $scope.selectAll = function () {
        _.forEach($scope.buckets, function (bucket) {
            bucket.__selected = true;
        });
    };

    $scope.deselectAll = function () {
        _.forEach($scope.buckets, function (bucket) {
            bucket.__selected = false;
        });
    };

    $scope.selectedCount = function () {
        try {
            return _.filter($scope.buckets, function (bucket) {
                return bucket.__selected;
            }).length;
        }
        catch (err) {
            return 0;
        }
    };

    $scope.archiveBucket = function(bucket) {
        var query = {
            query: {
                filtered: {
                    query: {
                        query_string: {
                            query: $scope.buildQuery()
                        }
                    },
                    filter: {
                        and: [
                            {
                                term: { tags: "inbox"}
                            },
                            {
                                range: {
                                    "@timestamp": {
                                        "lte": bucket.last_timestamp.value
                                    }
                                }
                            },
                            {
                                term: {
                                    "alert.signature.raw": bucket.key
                                }
                            }
                        ]
                    }
                }
            },
            size: 1000,
            fields: ["_index", "_type", "_id"],
            sort: [
                {"@timestamp": {order: "desc"}}
            ]
        };

        return $modal.open({
            templateUrl: "templates/archive-events-by-query-modal.html",
            controller: "ArchiveEventsByQueryModal",
            resolve: {
                args: function () {
                    return {
                        "title": "Archiving: " + bucket.key,
                        "query": query
                    }
                }
            }
        });
    };

    $scope.archiveSelected = function () {
        var selectedBuckets = _.filter($scope.buckets, "__selected");

        var archiveBucket = function() {
            if (selectedBuckets.length > 0) {
                var bucket = selectedBuckets.pop();
                $scope.archiveBucket(bucket)
                    .result.then(function() {
                        _.remove($scope.buckets, bucket);
                        if (_.indexOf($scope.buckets, bucket) < $scope.activeRowIndex) {
                            $scope.activeRowIndex--;
                        }
                        archiveBucket();
                    });
            }
        };

        archiveBucket();
    };

    $scope.$on("$destroy", function () {
        console.log("GroupedAlertController: scope destroyed.");
        Keyboard.resetScope($scope);
    });

    Keyboard.scopeBind($scope, "o", function () {
        $scope.$apply(function () {
            var bucket = getActiveBucket();
            $scope.openAggregation(bucket);
        });
    });

    Keyboard.scopeBind($scope, "x", function () {
        $scope.$apply(function () {
            $scope.toggleSelected();
        });
    });

    Keyboard.scopeBind($scope, "e", function () {
        $scope.$apply(function () {
            $scope.archiveSelected();
        });
    })

});